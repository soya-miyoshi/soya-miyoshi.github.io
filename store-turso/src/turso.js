// Tasks in a Turso / libSQL database over the libSQL remote protocol.
//
// It mirrors the sqlite provider column for column: only the required fields
// of PLAN.md §3.2 are columns, tags are a join table, and everything a user
// defines lives in one JSON object in the fields column. The two packages are
// deliberately parallel, so that the same behaviour — the ordering, the
// sentinels, the LIKE escaping, the id normalization — is observable
// whichever store a command is pointed at.
//
// The tree rules of §3.1 and the availability computation of §3.3 are not
// written here. They live in @todocloud/core/store as pure functions over an
// in-memory tree, and this package loads the rows and asks. That is what
// keeps every provider's answer to "is this available?" the same answer, and
// @todocloud/store-testkit is what proves it.
//
// Writing is therefore always two round trips: one that reads the tree, and
// one that sends every statement of the change together. The decision in
// between is TypeScript, not SQL, which is the only way a provider that
// cannot open a transaction over the wire can still refuse exactly what
// SQLite refuses.
//
// The transport is the global `fetch`: one POST of a /v2/pipeline request,
// with as many statements batched into it as the operation has, authenticated
// with a bearer token. There is no libSQL driver and no SQLite engine in this
// package, and nothing here imports `node:*` — which is what lets the PWA
// talk to the user's database with this same code.
//
// What this package cannot do is as important as what it can. It issues
// requests to exactly one URL, the pipeline endpoint of the configured host,
// and executes SQL against the database that host serves. It never calls the
// Turso platform API, so no code path here can create, rename or destroy a
// database.
//
// Port notes:
//
//   - Every Store method is async, and the `context.Context` first parameter
//     is gone; see the note on the Store interface in core. The request
//     timeout that Go took from the context now lives in Config.
//   - `OpenExisting` reads the meta row, so it is async where Go's was not.
//   - Go's unexported methods on Store that query.ts and schema.ts also used
//     are marked @internal here: TypeScript has no package-private, and a
//     class cannot be split across files.
import { configf, providerf } from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import { databaseFromURL } from '@todocloud/core/providercli';
import { Secret } from '@todocloud/core/secret';
import { ErrAmbiguous, ErrExists, ErrNotEmpty, ErrNotFound, ErrNotInitialized, } from '@todocloud/core/store';
import { Tree, checkParent, cycleError, } from '@todocloud/core/store/availability';
import { autoComplete, triggersAutoCompletion } from '@todocloud/core/store/completion';
import { Fields, Task, formatTime, parseTime, } from '@todocloud/core/task';
import { Client, endpointFor, isRemoteError, } from "./client.js";
import { newStatement, } from "./protocol.js";
import * as query from "./query.js";
import * as schemaOps from "./schema.js";
export { SchemaVersion, metaSchemaVersion } from "./schema.js";
export { endpointFor, pipelinePath, RemoteError } from "./client.js";
/**
 * requestTimeoutMs bounds a request made without a timeout of the caller's
 * own. Every command is one or two round trips, so a minute is generous.
 */
export const requestTimeoutMs = 60_000;
/** probeTimeoutMs bounds the one request openExisting makes. */
export const probeTimeoutMs = 30_000;
/**
 * errClosed is thrown by a method called after close, instead of a null
 * dereference.
 */
export const errClosed = new Error('turso: the store is closed');
/** Store is a Turso-backed task store. */
export class Store {
    /** @internal The transport, or undefined once close has run. */
    client;
    /**
     * database is the name Describe reports. It is public where Go's was
     * package-private, because the sibling modules and the tests of this
     * package are separate files here; it is a database name, never a
     * credential.
     */
    database;
    /**
     * @internal version is the schema version last seen in the meta table, and
     * versionKnown says whether anything has looked yet. openExisting reads the
     * row to prove the database is initialized, so by the time a command runs,
     * checkSchema can answer from this without a second round trip.
     */
    version = 0;
    /** @internal */
    versionKnown = false;
    constructor(client, database) {
        this.client = client;
        this.database = database;
    }
    /**
     * describe names the database and nothing else. No token, no query string,
     * nothing that would be unsafe in `tdo config` output or in a bug report.
     */
    describe() {
        return `turso database ${JSON.stringify(this.database)}`;
    }
    /** ping checks that the database is reachable and initialized. */
    async ping() {
        await this.schemaVersion();
    }
    /**
     * close releases what there is to release. There is no connection to tear
     * down — each command is a request or two — so it only drops the client. It
     * is safe to call twice.
     */
    async close() {
        this.client = undefined;
    }
    // --- schema (schema.ts) ------------------------------------------------
    init() {
        return schemaOps.init(this);
    }
    schemaVersion() {
        return schemaOps.schemaVersion(this);
    }
    /**
     * checkSchema reports whether the store holds the schema this build writes.
     * It is core's VersionChecker capability: for this provider the answer is
     * free, because openExisting already read the meta row.
     */
    checkSchema() {
        return schemaOps.checkSchema(this);
    }
    migrate() {
        return schemaOps.migrate(this);
    }
    // --- queries (query.ts) -----------------------------------------------
    list(f) {
        return query.list(this, f);
    }
    children(parentID) {
        return query.children(this, parentID);
    }
    subtree(taskID) {
        return query.subtree(this, taskID);
    }
    availability(now, ...ids) {
        return query.availability(this, now, ...ids);
    }
    tags() {
        return query.tags(this);
    }
    setTagStatus(name, status, now) {
        return query.setTagStatus(this, name, status, now);
    }
    renameTag(from, to, now) {
        return query.renameTag(this, from, to, now);
    }
    removeTag(name) {
        return query.removeTag(this, name);
    }
    savePerspective(p) {
        return query.savePerspective(this, p);
    }
    perspective(name) {
        return query.perspective(this, name);
    }
    perspectives() {
        return query.perspectives(this);
    }
    deletePerspective(name) {
        return query.deletePerspective(this, name);
    }
    // --- the pipeline -----------------------------------------------------
    /**
     * @internal send executes a batch in one round trip and returns one result
     * per statement, in order.
     */
    async send(b) {
        const client = this.client;
        if (client === undefined) {
            throw errClosed;
        }
        b.check();
        return client.pipeline(...b.statements);
    }
    /** @internal exec runs one statement and returns its result. */
    async exec(sql, wantRows, ...args) {
        const b = new Batch();
        b.add(sql, wantRows, ...args);
        const out = await this.send(b);
        return out[0];
    }
    /**
     * @internal rememberVersion records what the last read or write of the meta
     * row saw, so that checkSchema can answer without a second round trip.
     */
    rememberVersion(v) {
        this.version = v;
        this.versionKnown = true;
    }
    /**
     * @internal wrap gives a failed statement its context and classifies it.
     *
     * A missing tasks table means the database holds no schema, which is a
     * configuration problem with a known remedy, not a provider failure; it is
     * reported as ErrNotInitialized and the engine's "no such table: tasks"
     * never reaches the user. Everything else the remote engine refused is a
     * provider error, so it exits 4.
     */
    wrap(err, what) {
        if (missingTable(err)) {
            return notInitialized(this.database);
        }
        const remote = isRemoteError(err);
        if (remote !== undefined) {
            return providerf(new Error(`turso: ${what}: ${remote.message}`, { cause: err }));
        }
        if (err instanceof Error) {
            return new Error(`turso: ${what}: ${err.message}`, { cause: err });
        }
        return new Error(`turso: ${what}: ${String(err)}`, { cause: err });
    }
    /** @internal loadTree reads every row into an in-memory tree. */
    loadTree() {
        return query.loadTree(this);
    }
    // --- tasks -------------------------------------------------------------
    /**
     * add inserts a new task with its tags. A duplicate id is ErrExists rather
     * than a silent overwrite, so a generator bug cannot destroy data.
     *
     * The tree is read first. There is no transaction over the wire, so the
     * placement rules of §3.1 and the duplicate check are decided here, before
     * anything is written: a pipeline whose first statement fails still runs the
     * rest, and a tag row written beside a refused insert would attach itself to
     * whatever already holds that id.
     */
    async add(task) {
        // Every lookup normalises the id, so an id stored in another case would
        // be unreachable afterwards. Normalising on the way in keeps the store's
        // one copy of an id canonical, and the same goes for the edges it carries.
        const t = normalizedCopy(task);
        const invalid = t.validate();
        if (invalid !== undefined) {
            throw new Error(`turso: add task ${t.id}: ${invalid.message}`, {
                cause: invalid,
            });
        }
        const tree = await this.loadTree();
        if (tree.get(t.id) !== undefined) {
            // The caller decides what a duplicate means — `tdo import` skips it —
            // so report the sentinel, never the engine's constraint message.
            throw new Error(`turso: ${t.id}: ${ErrExists.message}`, {
                cause: ErrExists,
            });
        }
        checkPlacement(tree, t);
        const b = new Batch();
        b.add(insertSQL, false, ...insertArgs(t));
        writeTags(b, t);
        try {
            await this.send(b);
        }
        catch (err) {
            if (isUniqueViolation(err)) {
                // The tree read above missed a concurrent writer. The answer is
                // still the sentinel and never the engine's message.
                throw new Error(`turso: ${t.id}: ${ErrExists.message}`, {
                    cause: ErrExists,
                });
            }
            throw this.wrap(err, 'add task ' + t.id);
        }
    }
    /** update replaces every column of the task with this id, tags included. */
    async update(task) {
        const t = normalizedCopy(task);
        const invalid = t.validate();
        if (invalid !== undefined) {
            throw new Error(`turso: update task ${t.id}: ${invalid.message}`, {
                cause: invalid,
            });
        }
        const tree = await this.loadTree();
        if (tree.get(t.id) === undefined) {
            throw new Error(`turso: ${t.id}: ${ErrNotFound.message}`, {
                cause: ErrNotFound,
            });
        }
        checkPlacement(tree, t);
        const args = insertArgs(t);
        const b = new Batch();
        // insertArgs puts the id first; the UPDATE wants it last.
        b.add(updateSQL, false, ...args.slice(1), args[0]);
        writeTags(b, t);
        // "Complete with last action" (§3.2's completed_by_children). The rule is
        // the shared one in core's autoComplete; this provider only asks it and
        // writes the answer. There is no transaction over the wire, so it is
        // asked about the tree this update is about to produce, and the container
        // updates travel in the same pipeline as the update that caused them.
        if (triggersAutoCompletion(t)) {
            for (const container of autoComplete(tree.withUpdated(t), t.id, t.updatedAt)) {
                const cargs = insertArgs(container);
                b.add(updateSQL, false, ...cargs.slice(1), cargs[0]);
            }
        }
        try {
            await this.send(b);
        }
        catch (err) {
            throw this.wrap(err, 'update task ' + t.id);
        }
    }
    /**
     * move reparents a task and sets its position, touching nothing else but
     * updated_at. It is the one operation that exists so a caller does not have
     * to read, edit and write back a whole task to drag it somewhere.
     */
    async move(taskID, parentID, position, now) {
        const normalized = id.Normalize(taskID);
        const parent = id.Normalize(parentID);
        const tree = await this.loadTree();
        const current = tree.get(normalized);
        if (current === undefined) {
            throw new Error(`turso: ${normalized}: ${ErrNotFound.message}`, {
                cause: ErrNotFound,
            });
        }
        const moved = current.clone();
        moved.parentID = parent;
        moved.position = position;
        checkPlacement(tree, moved);
        const q = `UPDATE tasks SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?`;
        try {
            await this.exec(q, false, nullString(parent), position, formatTime(now), normalized);
        }
        catch (err) {
            throw this.wrap(err, 'move task ' + normalized);
        }
    }
    /**
     * get returns the task with exactly this id, tombstoned or not. The row and
     * its tags travel in one pipeline, so a read is one round trip.
     */
    async get(taskID) {
        const normalized = id.Normalize(taskID);
        const b = new Batch();
        b.add(`SELECT ${columns} FROM tasks WHERE id = ?`, true, normalized);
        b.add(`SELECT task_id, tag FROM task_tags WHERE task_id = ? ORDER BY tag_key`, true, normalized);
        let res;
        try {
            res = await this.send(b);
        }
        catch (err) {
            throw this.wrap(err, 'get task ' + taskID);
        }
        const rows = res[0].rows;
        if (rows.length === 0) {
            throw new Error(`turso: ${taskID}: ${ErrNotFound.message}`, {
                cause: ErrNotFound,
            });
        }
        try {
            const t = scanTask(rows[0]);
            attachTags([t], res[1]);
            return t;
        }
        catch (err) {
            throw new Error(`turso: get task ${taskID}: ${messageOf(err)}`, {
                cause: err,
            });
        }
    }
    /**
     * findByPrefix returns the single task whose id starts with prefix. It reads
     * at most two rows, because two is all it takes to know the prefix is
     * ambiguous, and it asks for the matching tags in the same pipeline.
     */
    async findByPrefix(prefix) {
        const pattern = escapeLike(id.Normalize(prefix)) + '%';
        const b = new Batch();
        b.add(`SELECT ${columns} FROM tasks WHERE id LIKE ? ESCAPE '\\' ORDER BY id LIMIT 2`, true, pattern);
        b.add(`SELECT task_id, tag FROM task_tags WHERE task_id LIKE ? ESCAPE '\\' ORDER BY task_id, tag_key`, true, pattern);
        let res;
        try {
            res = await this.send(b);
        }
        catch (err) {
            throw this.wrap(err, 'find task ' + prefix);
        }
        const rows = res[0].rows;
        switch (rows.length) {
            case 0:
                throw new Error(`turso: ${prefix}: ${ErrNotFound.message}`, {
                    cause: ErrNotFound,
                });
            case 1:
                try {
                    const t = scanTask(rows[0]);
                    attachTags([t], res[1]);
                    return t;
                }
                catch (err) {
                    throw new Error(`turso: find task ${prefix}: ${messageOf(err)}`, {
                        cause: err,
                    });
                }
            default:
                throw new Error(`turso: ${prefix}: ${ErrAmbiguous.message}`, {
                    cause: ErrAmbiguous,
                });
        }
    }
    /**
     * purge removes a task irreversibly. Ordinary removal is an update that
     * sets the tombstone, so that multi-device sync stays possible.
     *
     * A task that still has children is refused: purging it would orphan them,
     * and an orphan is invisible in every listing that walks the tree.
     */
    async purge(taskID) {
        const normalized = id.Normalize(taskID);
        const tree = await this.loadTree();
        if (tree.get(normalized) === undefined) {
            throw new Error(`turso: ${taskID}: ${ErrNotFound.message}`, {
                cause: ErrNotFound,
            });
        }
        const n = tree.children(normalized).length;
        if (n > 0) {
            throw new Error(`turso: ${taskID} still contains ${n} item(s); purge them too with --recursive: ${ErrNotEmpty.message}`, { cause: ErrNotEmpty });
        }
        const b = new Batch();
        deleteTask(b, normalized);
        try {
            await this.send(b);
        }
        catch (err) {
            throw this.wrap(err, 'purge task ' + taskID);
        }
    }
    /**
     * purgeSubtree removes a task and everything beneath it irreversibly. The
     * deletes are sent depth-first in one pipeline, so that no row is removed
     * while a child still points at it — a foreign key that is switched on would
     * refuse that, and a half-deleted subtree would be worse than a slow one.
     */
    async purgeSubtree(taskID) {
        const normalized = id.Normalize(taskID);
        const tree = await this.loadTree();
        const nodes = tree.subtree(normalized);
        if (nodes.length === 0) {
            throw new Error(`turso: ${taskID}: ${ErrNotFound.message}`, {
                cause: ErrNotFound,
            });
        }
        const b = new Batch();
        for (let i = nodes.length - 1; i >= 0; i--) {
            deleteTask(b, nodes[i].id);
        }
        try {
            await this.send(b);
        }
        catch (err) {
            throw this.wrap(err, 'purge task ' + taskID);
        }
        return nodes.length;
    }
}
/**
 * open prepares a store against the configured database. It is the entry
 * point `tdo init` uses: it does not require a schema to be present, because
 * init is what puts one there.
 *
 * Opening performs no request. Nothing exists to create remotely — the
 * database the URL names either exists or it does not, and this package never
 * creates one — so a bad URL surfaces on the first command rather than here.
 */
export function open(cfg) {
    let endpoint;
    let host;
    try {
        ({ endpoint, host } = endpointFor(cfg.url));
    }
    catch (err) {
        throw configf(err instanceof Error ? err : new Error(String(err)));
    }
    const fetchImpl = cfg.fetch ?? defaultFetch();
    const timeout = cfg.timeoutMs ?? requestTimeoutMs;
    const client = new Client(endpoint, host, cfg.token ?? new Secret(''), fetchImpl, timeout);
    return new Store(client, databaseName(cfg.url, host));
}
/**
 * openExisting opens a store that must already hold a schema. It is what
 * every command other than `tdo init` uses, and it creates nothing: the one
 * request it makes is a read of the meta table.
 *
 * A database with no schema is reported as ErrNotInitialized, so that pointing
 * the CLI at the wrong database fails with the advice to run `tdo init`
 * instead of quietly growing a second, parallel task list.
 *
 * The probe reads the version, not merely the presence of the row, and the
 * store keeps it: checkSchema then costs nothing, which is what lets every
 * command check the version rather than only `tdo doctor` and `tdo migrate`.
 * A version this build does not understand is deliberately not refused
 * here — `tdo migrate` has to be able to open exactly that store.
 */
export async function openExisting(cfg) {
    // The probe has a deadline of its own, shorter than a command's: a store
    // that cannot even be identified is not worth a minute of waiting.
    const s = open({
        ...cfg,
        timeoutMs: cfg.probeTimeoutMs ?? cfg.timeoutMs ?? probeTimeoutMs,
    });
    try {
        await s.schemaVersion();
    }
    catch (err) {
        await s.close();
        throw err;
    }
    // Everything after the probe is an ordinary command, so it gets the
    // ordinary timeout.
    const client = s.client;
    if (client !== undefined) {
        s.client = client.withTimeout(cfg.timeoutMs ?? requestTimeoutMs);
    }
    return s;
}
/**
 * defaultFetch is the runtime's own fetch, bound so that a call does not
 * depend on `globalThis` being the receiver. A runtime without one is a
 * configuration error rather than a crash at the first request.
 */
function defaultFetch() {
    const f = globalThis.fetch;
    if (typeof f !== 'function') {
        throw configf(new Error('turso: this runtime has no fetch; pass one in Config.fetch (Node 18+ and every browser have one)'));
    }
    return f.bind(globalThis);
}
/**
 * databaseName recovers the database's name from its URL, for describe. The
 * host is the fallback whenever the name cannot be read confidently; both are
 * public information, neither is a credential.
 */
function databaseName(rawURL, host) {
    const [name, ok] = databaseFromURL(rawURL);
    if (ok) {
        return name;
    }
    return host;
}
/** notInitialized is the one shape every method reports a schema-less store as. */
export function notInitialized(database) {
    return new Error(`turso: ${database}: ${ErrNotInitialized.message}`, {
        cause: ErrNotInitialized,
    });
}
/**
 * batch collects the statements of one pipeline. It carries the first binding
 * failure rather than throwing from add, so that building a multi-statement
 * operation reads as a list of statements and not as a ladder of try blocks.
 */
export class Batch {
    statements = [];
    err;
    add(sql, wantRows, ...args) {
        if (this.err !== undefined) {
            return;
        }
        try {
            this.statements.push(newStatement(sql, wantRows, ...args));
        }
        catch (err) {
            this.err = new Error(`turso: ${messageOf(err)}`, { cause: err });
        }
    }
    /**
     * len reports how many statements are queued, which is also the index the
     * next one will have in the results.
     */
    len() {
        return this.statements.length;
    }
    /** check raises the first binding failure, if there was one. */
    check() {
        if (this.err !== undefined) {
            throw this.err;
        }
    }
}
export const columns = `id, kind, title, parent_id, position, status, flagged, sequential,
	completed_by_children, defer_at, due_at, estimated_minutes, note, repeat, series_id,
	review_interval, last_reviewed_at, created_at, updated_at, completed_at, dropped_at,
	deleted_at, fields`;
export const columnCount = 23;
const placeholders = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`;
const insertSQL = `INSERT INTO tasks (${columns}) VALUES (${placeholders})`;
const updateSQL = `UPDATE tasks SET kind = ?, title = ?, parent_id = ?, position = ?, status = ?,
	           flagged = ?, sequential = ?, completed_by_children = ?, defer_at = ?, due_at = ?,
	           estimated_minutes = ?, note = ?, repeat = ?, series_id = ?, review_interval = ?,
	           last_reviewed_at = ?, created_at = ?, updated_at = ?, completed_at = ?,
	           dropped_at = ?, deleted_at = ?, fields = ? WHERE id = ?`;
/**
 * checkPlacement enforces the tree rules of §3.1 for the placement t
 * describes, over the snapshot the caller read: the parent must exist, its
 * kind must be allowed to contain this one, and the parent must not be t
 * itself or one of its descendants.
 *
 * The table and the cycle rule are the shared ones, so that this provider
 * cannot drift from SQLite about what a legal tree is. Go returned the error;
 * it is thrown here, because every caller passed it straight up.
 */
export function checkPlacement(tree, t) {
    if (t.parentID === '') {
        return;
    }
    if (t.parentID === t.id) {
        throw cycleError(t.id, t.parentID);
    }
    const parent = tree.get(t.parentID);
    if (parent === undefined) {
        throw new Error(`turso: parent ${t.parentID}: ${ErrNotFound.message}`, {
            cause: ErrNotFound,
        });
    }
    const bad = checkParent(t.kind, parent);
    if (bad !== undefined) {
        throw new Error(`turso: ${bad.message}`, { cause: bad });
    }
    // Moving an item under one of its own descendants would cut its branch
    // loose from the root.
    if (tree.hasDescendant(t.id, t.parentID)) {
        throw cycleError(t.id, t.parentID);
    }
}
/**
 * escapeLike neutralises the LIKE wildcards. An id prefix cannot contain
 * them, but the caller is not required to have validated one, so `%` must
 * match a literal percent sign and nothing else.
 */
export function escapeLike(s) {
    let out = '';
    for (const ch of s) {
        if (ch === '\\' || ch === '%' || ch === '_') {
            out += '\\';
        }
        out += ch;
    }
    return out;
}
/**
 * deleteTask queues the removal of one row and its tags. The tag rows are
 * deleted explicitly rather than left to ON DELETE CASCADE: a remote
 * connection need not have foreign keys switched on, and a tag row pointing
 * at a purged task would keep counting in `tdo tags`.
 */
function deleteTask(b, taskID) {
    b.add(`DELETE FROM task_tags WHERE task_id = ?`, false, taskID);
    b.add(`DELETE FROM tasks WHERE id = ?`, false, taskID);
}
/**
 * writeTags queues the tag rows of a task, replacing whatever is there.
 * Replacing rather than diffing keeps the table a function of the task the
 * caller handed over, which is what makes `tdo edit --tag a,b` subtractive as
 * well as additive.
 */
function writeTags(b, t) {
    b.add(`DELETE FROM task_tags WHERE task_id = ?`, false, t.id);
    const q = `INSERT INTO task_tags (task_id, tag, tag_key) VALUES (?, ?, ?)
	           ON CONFLICT(task_id, tag_key) DO UPDATE SET tag = excluded.tag`;
    // A tag used for the first time gets a row of its own, active, so that
    // `tdo tag ls` and `tdo tag hold` can reach it. DO NOTHING on conflict:
    // a tag that already has a status must not be reset to active by
    // someone tagging a task with it.
    const row = `INSERT INTO tags (tag_key, tag, status, created_at, updated_at)
	           VALUES (?, ?, 'active', ?, ?) ON CONFLICT(tag_key) DO NOTHING`;
    const stamp = formatTime(t.updatedAt);
    for (const raw of t.tags) {
        const tag = raw.trim();
        if (tag === '') {
            continue;
        }
        const key = tag.toLowerCase();
        b.add(q, false, t.id, tag, key);
        b.add(row, false, key, tag, stamp, stamp);
    }
}
/**
 * attachTags fills in the tags of the given tasks from a (task_id, tag)
 * result, which the caller asked for in the same pipeline as the rows.
 */
export function attachTags(tasks, res) {
    const byTask = new Map();
    for (const row of res.rows) {
        if (row.length !== 2) {
            throw new Error(`a tag row came back with ${row.length} column(s), want 2`);
        }
        const taskID = text(row[0], 'task_id');
        const tag = text(row[1], 'tag');
        const have = byTask.get(taskID);
        if (have === undefined) {
            byTask.set(taskID, [tag]);
        }
        else {
            have.push(tag);
        }
    }
    for (const t of tasks) {
        t.setTags(byTask.get(t.id) ?? []);
    }
}
/**
 * missingTable reports whether err is the engine's complaint about a table
 * that does not exist. libSQL offers no distinct code for it, so the message
 * is matched — in one place, and never passed on to the user.
 */
export function missingTable(err) {
    const remote = isRemoteError(err);
    if (remote === undefined) {
        return false;
    }
    return remote.engineText().toLowerCase().includes('no such table');
}
/**
 * isUniqueViolation reports whether err is the primary-key conflict. Both the
 * SQLITE_CONSTRAINT_* code and the message are matched, because servers
 * differ in which of the two they fill in.
 */
export function isUniqueViolation(err) {
    const remote = isRemoteError(err);
    if (remote === undefined) {
        return false;
    }
    const msg = remote.engineText().toLowerCase();
    return (msg.includes('unique constraint failed') ||
        msg.includes('constraint failed: unique') ||
        msg.includes('sqlite_constraint_primarykey') ||
        msg.includes('sqlite_constraint_unique'));
}
/**
 * normalizedCopy returns a copy of t with its id and its id-valued edges in
 * the canonical spelling, so that a caller passing a lower-cased id neither
 * writes an unreachable row nor has its own value rewritten underneath it.
 */
function normalizedCopy(t) {
    const c = t.clone();
    c.id = id.Normalize(c.id);
    c.parentID = id.Normalize(c.parentID);
    c.seriesID = id.Normalize(c.seriesID);
    return c;
}
function insertArgs(t) {
    return [
        t.id,
        t.kind,
        t.title,
        nullString(t.parentID),
        t.position,
        t.status,
        boolToInt(t.flagged),
        boolToInt(t.sequential),
        boolToInt(t.completedByChildren),
        optionalTime(t.deferAt),
        optionalTime(t.dueAt),
        t.estimatedMinutes,
        nullString(t.note),
        marshalJSON(t.repeat, 'repeat'),
        nullString(t.seriesID),
        marshalJSON(t.reviewInterval, 'review_interval'),
        optionalTime(t.lastReviewedAt),
        formatTime(t.createdAt),
        formatTime(t.updatedAt),
        optionalTime(t.completedAt),
        optionalTime(t.droppedAt),
        optionalTime(t.deletedAt),
        marshalFields(t.fields),
    ];
}
/**
 * scanTask reads one row of the column list above. Every malformed column is
 * an error rather than a zero value: a task that came back with no title
 * should be a failed command, not a blank line.
 */
export function scanTask(row) {
    if (row.length !== columnCount) {
        throw new Error(`a row came back with ${row.length} column(s), want ${columnCount}`);
    }
    const t = new Task();
    t.id = text(row[0], 'id');
    t.kind = text(row[1], 'kind');
    t.title = text(row[2], 'title');
    t.parentID = optionalText(row[3], 'parent_id');
    t.position = Number(integer(row[4], 'position'));
    t.status = text(row[5], 'status');
    for (const flag of [
        { column: 'flagged', raw: row[6], set: (v) => (t.flagged = v) },
        {
            column: 'sequential',
            raw: row[7],
            set: (v) => (t.sequential = v),
        },
        {
            column: 'completed_by_children',
            raw: row[8],
            set: (v) => (t.completedByChildren = v),
        },
    ]) {
        flag.set(integer(flag.raw, flag.column) !== 0n);
    }
    t.estimatedMinutes = Number(integer(row[11], 'estimated_minutes'));
    t.note = optionalText(row[12], 'note');
    t.seriesID = optionalText(row[14], 'series_id');
    t.createdAt = parseTime(text(row[17], 'created_at'));
    t.updatedAt = parseTime(text(row[18], 'updated_at'));
    for (const slot of [
        { column: 'defer_at', raw: row[9], set: (v) => (t.deferAt = v) },
        { column: 'due_at', raw: row[10], set: (v) => (t.dueAt = v) },
        {
            column: 'last_reviewed_at',
            raw: row[16],
            set: (v) => (t.lastReviewedAt = v),
        },
        {
            column: 'completed_at',
            raw: row[19],
            set: (v) => (t.completedAt = v),
        },
        {
            column: 'dropped_at',
            raw: row[20],
            set: (v) => (t.droppedAt = v),
        },
        {
            column: 'deleted_at',
            raw: row[21],
            set: (v) => (t.deletedAt = v),
        },
    ]) {
        slot.set(optionalColumn(slot.raw, slot.column));
    }
    const repeat = optionalText(row[13], 'repeat');
    if (repeat !== '') {
        try {
            t.repeat = JSON.parse(repeat);
        }
        catch (err) {
            throw new Error(`decode the repeat of ${t.id}: ${messageOf(err)}`, {
                cause: err,
            });
        }
    }
    const review = optionalText(row[15], 'review_interval');
    if (review !== '') {
        try {
            t.reviewInterval = JSON.parse(review);
        }
        catch (err) {
            throw new Error(`decode the review interval of ${t.id}: ${messageOf(err)}`, { cause: err });
        }
    }
    t.fields = unmarshalFields(optionalText(row[22], 'fields'));
    t.tags = [];
    return t;
}
export function text(v, column) {
    if (v.isNull()) {
        throw new Error(`the ${column} column is null`);
    }
    const s = v.text();
    if (s === undefined) {
        throw new Error(`the ${column} column is not text`);
    }
    return s;
}
/**
 * optionalText reads a nullable text column, with NULL as the empty string:
 * the TypeScript side of every one of them is a string whose empty value
 * means unset.
 */
export function optionalText(v, column) {
    if (v.isNull()) {
        return '';
    }
    return text(v, column);
}
export function integer(v, column) {
    if (v.isNull()) {
        throw new Error(`the ${column} column is null`);
    }
    const n = v.int64();
    if (n === undefined) {
        throw new Error(`the ${column} column is not an integer`);
    }
    return n;
}
function optionalColumn(v, column) {
    const s = optionalText(v, column);
    if (s === '') {
        return undefined;
    }
    return parseTime(s);
}
/**
 * marshalFields renders the user-defined part of a task. An empty map is
 * stored as an empty object rather than NULL, so the column is never null.
 */
function marshalFields(f) {
    if (Object.keys(f).length === 0) {
        return '{}';
    }
    try {
        return JSON.stringify(f);
    }
    catch (err) {
        throw new Error(`turso: encode fields: ${messageOf(err)}`, { cause: err });
    }
}
/** marshalJSON renders a small optional object column, NULL when unset. */
function marshalJSON(v, name) {
    if (v === undefined) {
        return null;
    }
    try {
        return JSON.stringify(v);
    }
    catch (err) {
        throw new Error(`turso: encode ${name}: ${messageOf(err)}`, { cause: err });
    }
}
/**
 * unmarshalFields reads the fields column back. Go decoded through
 * json.Number so that Fields.normalize could give each value the Go type the
 * rest of the CLI stores; JavaScript has one number type, so the decode is
 * plain and normalize is still called — it is what gives a well-known key
 * like priority its documented form. The result is never null.
 */
function unmarshalFields(raw) {
    if (raw.trim() === '') {
        return {};
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`decode fields: ${messageOf(err)}`, { cause: err });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('decode fields: the fields column is not a JSON object');
    }
    const f = parsed;
    Fields.normalize(f);
    return f;
}
function boolToInt(b) {
    return b ? 1 : 0;
}
function nullString(s) {
    if (s === '') {
        return null;
    }
    return s;
}
function optionalTime(t) {
    if (t === undefined) {
        return null;
    }
    return formatTime(t);
}
/** messageOf is the message of a thrown value, whatever it is. */
export function messageOf(err) {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}
//# sourceMappingURL=turso.js.map