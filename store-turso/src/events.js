// The event half of the provider: events, and the links from the tasks that
// wait for them. The sqlite provider's events.ts, over the wire.
//
// There is no transaction over the wire, so each operation that must not be
// half-done reads first and writes second: every reference is checked before
// a single write goes up, and a write that has several parts travels as one
// pipeline. Neither foreign key is relied on; every delete removes the links
// itself.
import * as id from '@todocloud/core/id';
import { ErrAmbiguous, ErrBadParent, ErrExists, ErrNotFound } from '@todocloud/core/store';
import { EventItem } from '@todocloud/core/store/event';
import { formatTime, KindProject, parseTime } from '@todocloud/core/task';
import { Batch, escapeLike, isUniqueViolation, messageOf, optionalColumn, optionalText, optionalTime, text, } from "./turso.js";
export const eventColumns = `id, title, project_id, note, expected_at, status, occurred_at, created_at, updated_at`;
export const eventRowsSQL = `SELECT ${eventColumns} FROM events ORDER BY created_at, id`;
export const linkRowsSQL = `SELECT task_id, event_id FROM task_events ORDER BY task_id, event_id`;
/** scanEvent decodes one row of the events table. */
export function scanEvent(row) {
    if (row.length !== 9) {
        throw new Error(`an event row came back with ${row.length} column(s), want 9`);
    }
    const e = new EventItem();
    e.id = text(row[0], 'id');
    e.title = text(row[1], 'title');
    e.projectID = optionalText(row[2], 'project_id');
    e.note = optionalText(row[3], 'note');
    e.expectedAt = optionalColumn(row[4], 'expected_at');
    e.status = text(row[5], 'status');
    e.occurredAt = optionalColumn(row[6], 'occurred_at');
    e.createdAt = parseTime(text(row[7], 'created_at'));
    e.updatedAt = parseTime(text(row[8], 'updated_at'));
    return e;
}
/** scanEvents reads the events out of a result. */
export function scanEvents(res) {
    return res.rows.map((row) => scanEvent(row));
}
/** scanLinks reads the links out of a result. */
export function scanLinks(res) {
    return res.rows.map((row) => {
        if (row.length !== 2) {
            throw new Error(`a link row came back with ${row.length} column(s), want 2`);
        }
        return {
            taskID: text(row[0], 'task_id'),
            eventID: text(row[1], 'event_id'),
        };
    });
}
function eventArgs(e) {
    return [
        e.id,
        e.title,
        e.projectID === '' ? null : e.projectID,
        e.note === '' ? null : e.note,
        optionalTime(e.expectedAt),
        e.status,
        optionalTime(e.occurredAt),
        formatTime(e.createdAt),
        formatTime(e.updatedAt),
    ];
}
function normalized(e, op) {
    const item = e.clone();
    item.id = id.Normalize(item.id);
    item.projectID = id.Normalize(item.projectID);
    const invalid = item.validate();
    if (invalid !== undefined) {
        throw new Error(`turso: ${op} ${item.id}: ${invalid.message}`, { cause: invalid });
    }
    return item;
}
function notFound(what) {
    return new Error(`turso: ${what}: ${ErrNotFound.message}`, { cause: ErrNotFound });
}
/**
 * checkProject reads the project an event names: it must exist and it must be
 * a project. There is no transaction over the wire, so it is read first and the
 * write follows; no constraint says "is a project" anyway.
 */
async function checkProject(s, e) {
    if (e.projectID === '') {
        return;
    }
    let res;
    try {
        res = await s.exec(`SELECT kind FROM tasks WHERE id = ?`, true, e.projectID);
    }
    catch (err) {
        throw s.wrap(err, 'read project ' + e.projectID);
    }
    const row = res.rows[0];
    if (row === undefined) {
        throw notFound(`project ${e.projectID}`);
    }
    const kind = text(row[0], 'kind');
    if (kind !== KindProject) {
        throw new Error(`turso: ${e.projectID} is a ${kind}, not a project`, { cause: ErrBadParent });
    }
}
export async function addEvent(s, e) {
    const item = normalized(e, 'add event');
    await checkProject(s, item);
    const q = `INSERT INTO events (${eventColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    try {
        await s.exec(q, false, ...eventArgs(item));
    }
    catch (err) {
        if (isUniqueViolation(err)) {
            throw new Error(`turso: event ${item.id}: ${ErrExists.message}`, { cause: ErrExists });
        }
        throw s.wrap(err, 'add event ' + item.id);
    }
}
export async function getEvent(s, ref) {
    const want = id.Normalize(ref);
    let res;
    try {
        res = await s.exec(`SELECT ${eventColumns} FROM events WHERE id = ?`, true, want);
    }
    catch (err) {
        throw s.wrap(err, 'get event ' + ref);
    }
    const row = res.rows[0];
    if (row === undefined) {
        throw notFound(`event ${ref}`);
    }
    try {
        return scanEvent(row);
    }
    catch (err) {
        throw new Error(`turso: get event ${ref}: ${messageOf(err)}`, { cause: err });
    }
}
export async function findEventByPrefix(s, prefix) {
    const p = id.Normalize(prefix);
    let res;
    try {
        res = await s.exec(`SELECT ${eventColumns} FROM events WHERE id LIKE ? ESCAPE '\\' ORDER BY id LIMIT 2`, true, `${escapeLike(p)}%`);
    }
    catch (err) {
        throw s.wrap(err, 'find event ' + prefix);
    }
    if (res.rows.length > 1) {
        throw new Error(`turso: event ${prefix}: ${ErrAmbiguous.message}`, { cause: ErrAmbiguous });
    }
    const row = res.rows[0];
    if (row === undefined) {
        throw notFound(`event ${prefix}`);
    }
    return scanEvent(row);
}
export async function events(s) {
    let res;
    try {
        res = await s.exec(eventRowsSQL, true);
    }
    catch (err) {
        throw s.wrap(err, 'list events');
    }
    try {
        return scanEvents(res);
    }
    catch (err) {
        throw new Error(`turso: list events: ${messageOf(err)}`, { cause: err });
    }
}
export async function updateEvent(s, e) {
    const item = normalized(e, 'update event');
    // Existence is checked first: an UPDATE that matches nothing is not an
    // error on the wire, and "no such event" must not look like success.
    await getEvent(s, item.id);
    await checkProject(s, item);
    const a = eventArgs(item);
    const q = `UPDATE events SET title = ?, project_id = ?, note = ?, expected_at = ?, status = ?,
	           occurred_at = ?, updated_at = ? WHERE id = ?`;
    try {
        await s.exec(q, false, a[1], a[2], a[3], a[4], a[5], a[6], a[8], item.id);
    }
    catch (err) {
        throw s.wrap(err, 'update event ' + item.id);
    }
}
export async function removeEvent(s, ref) {
    const want = id.Normalize(ref);
    const b = new Batch();
    b.add(`SELECT COUNT(*) FROM events WHERE id = ?`, true, want);
    b.add(`SELECT COUNT(*) FROM task_events WHERE event_id = ?`, true, want);
    let res;
    try {
        res = await s.send(b);
    }
    catch (err) {
        throw s.wrap(err, 'remove event ' + ref);
    }
    const count = (r) => {
        const v = r?.rows[0]?.[0];
        return v === undefined ? 0 : Number(v.text() ?? 0);
    };
    if (count(res[0]) === 0) {
        throw notFound(`event ${ref}`);
    }
    const links = count(res[1]);
    const w = new Batch();
    w.add(`DELETE FROM task_events WHERE event_id = ?`, false, want);
    w.add(`DELETE FROM events WHERE id = ?`, false, want);
    try {
        await s.send(w);
    }
    catch (err) {
        throw s.wrap(err, 'remove event ' + ref);
    }
    return links;
}
/**
 * setWaits replaces the set of events a task waits for. Both ends are read
 * and checked first, so a reference that means nothing leaves the links as
 * they were; the replacement itself is one pipeline.
 */
export async function setWaits(s, taskRef, eventRefs) {
    const taskID = id.Normalize(taskRef);
    const ids = [...new Set(eventRefs.map((r) => id.Normalize(r)))];
    const check = new Batch();
    check.add(`SELECT id FROM tasks WHERE id = ?`, true, taskID);
    for (const e of ids) {
        check.add(`SELECT id FROM events WHERE id = ?`, true, e);
    }
    let res;
    try {
        res = await s.send(check);
    }
    catch (err) {
        throw s.wrap(err, 'set waits of ' + taskRef);
    }
    if (res[0].rows.length === 0) {
        throw notFound(`task ${taskRef}`);
    }
    for (let i = 0; i < ids.length; i++) {
        if (res[i + 1].rows.length === 0) {
            throw notFound(`event ${ids[i]}`);
        }
    }
    const b = new Batch();
    b.add(`DELETE FROM task_events WHERE task_id = ?`, false, taskID);
    for (const e of ids) {
        b.add(`INSERT INTO task_events (task_id, event_id) VALUES (?, ?)`, false, taskID, e);
    }
    try {
        await s.send(b);
    }
    catch (err) {
        throw s.wrap(err, 'set waits of ' + taskRef);
    }
}
export async function waits(s) {
    let res;
    try {
        res = await s.exec(linkRowsSQL, true);
    }
    catch (err) {
        throw s.wrap(err, 'read event links');
    }
    try {
        return scanLinks(res);
    }
    catch (err) {
        throw new Error(`turso: read event links: ${messageOf(err)}`, { cause: err });
    }
}
//# sourceMappingURL=events.js.map