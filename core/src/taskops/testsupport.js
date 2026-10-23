// Test-only helpers for this module, shared by its test files the way Go's
// package-level test helpers were shared between the files of one package. It
// is not in the package's exports map and nothing outside `*.test.ts` in this
// directory may import it.
//
// It lives here as a `.ts` rather than inside a `.test.ts` because two test
// files need it and importing one test file from another would run its tests
// twice. It imports no `node:*` module, so `browser-safe.test.ts` is satisfied
// by it the same way it is by the sources.
//
// The store below is an in-memory Store built on `Tree`, which is also what
// the real providers compute §3.1, §3.3 and §3.3a from. It is deliberately
// NOT a second implementation of those rules: it answers them by calling the
// same shared functions, so a test here fails on what this module did and not
// on a disagreement between two fakes. Provider behaviour itself is the
// conformance suite's job (`@todocloud/store-testkit`), not this file's.
import { KindTask, StatusActive, newTask, } from "../task.js";
import { ErrExists, ErrNotFound, sortTasks, } from "../store/store.js";
import { Filter } from "../store/filter.js";
import { Tree, checkParent, cycleError } from "../store/availability.js";
/** A fixed instant, so that a stamped timestamp is comparable in an assert. */
export const now = new Date('2026-03-01T09:00:00Z');
/** at returns now plus n hours, for a defer or a due date. */
export function at(hours) {
    return new Date(now.getTime() + hours * 3600 * 1000);
}
/**
 * Literal ids, 26-character Crockford base32 as a ULID is, so that a test can
 * assert on an order that breaks ties by id.
 */
export const idA = '01J3AAAAAAAAAAAAAAAAAAAAAA';
export const idB = '01J3BBBBBBBBBBBBBBBBBBBBBB';
export const idC = '01J3CCCCCCCCCCCCCCCCCCCCCC';
export const idD = '01J3DDDDDDDDDDDDDDDDDDDDDD';
export const idE = '01J3EEEEEEEEEEEEEEEEEEEEEE';
/** An IDGen that hands out the ids it was given, then refuses. */
export function ids(...queue) {
    const rest = [...queue];
    return () => {
        const next = rest.shift();
        if (next === undefined) {
            throw new Error('the test asked for more ids than it pinned');
        }
        return next;
    };
}
/** A task with the fields a test cares about and sane values for the rest. */
export function task(id, init) {
    const t = newTask(id, init?.kind ?? KindTask, init?.title ?? id, now);
    t.parentID = init?.parentID ?? '';
    t.position = init?.position ?? 0;
    t.status = init?.status ?? StatusActive;
    return t;
}
/**
 * MemStore is the fake Store. Every read returns clones, as a real provider
 * does, so a test cannot accidentally mutate the stored row through the task
 * it got back — which is exactly the mistake the `clone()` in this module's
 * operations exists to prevent, and a fake that shared its rows would hide.
 */
export class MemStore {
    rows = new Map();
    /** calls records every mutating call in order, for the ordering tests. */
    calls = [];
    /**
     * fail makes the next matching call throw. It is how a test reaches the
     * "the write failed, so the task is still open" paths, which are the ones
     * a real provider only produces on a bad day.
     */
    fail = undefined;
    constructor(tasks = []) {
        for (const t of tasks) {
            this.rows.set(t.id, t.clone());
        }
    }
    /** stored returns the row as the store holds it, for an assertion. */
    stored(id) {
        return this.rows.get(id)?.clone();
    }
    /** count is how many rows the store holds, tombstoned ones included. */
    count() {
        return this.rows.size;
    }
    record(op, id) {
        this.calls.push({ op, id });
        const f = this.fail;
        if (f !== undefined && f.op === op && (f.id === undefined || f.id === id)) {
            this.fail = undefined;
            throw f.err;
        }
    }
    tree() {
        return new Tree([...this.rows.values()].map((t) => t.clone()));
    }
    init() {
        return Promise.resolve();
    }
    schemaVersion() {
        return Promise.resolve(1);
    }
    migrate() {
        return Promise.resolve();
    }
    add(t) {
        this.record('add', t.id);
        if (this.rows.has(t.id)) {
            return Promise.reject(new Error(`${t.id}: ${ErrExists.message}`, { cause: ErrExists }));
        }
        const bad = checkParent(t.kind, t.parentID === '' ? undefined : this.rows.get(t.parentID));
        if (bad !== undefined) {
            return Promise.reject(bad);
        }
        this.rows.set(t.id, t.clone());
        return Promise.resolve();
    }
    get(id) {
        const t = this.rows.get(id);
        if (t === undefined) {
            return Promise.reject(new Error(`${id}: ${ErrNotFound.message}`, { cause: ErrNotFound }));
        }
        return Promise.resolve(t.clone());
    }
    findByPrefix(prefix) {
        return this.get(prefix);
    }
    list(f) {
        const tr = this.tree();
        const out = tr.all().filter((t) => f.matches(t, tr));
        sortTasks(out, f.order, (t) => tr.sortKey(t));
        return Promise.resolve(f.limit > 0 ? out.slice(0, f.limit) : out);
    }
    update(t) {
        this.record('update', t.id);
        if (!this.rows.has(t.id)) {
            return Promise.reject(new Error(`${t.id}: ${ErrNotFound.message}`, { cause: ErrNotFound }));
        }
        this.rows.set(t.id, t.clone());
        return Promise.resolve();
    }
    move(id, parentID, position, at) {
        this.record('move', id);
        const t = this.rows.get(id);
        if (t === undefined) {
            return Promise.reject(new Error(`${id}: ${ErrNotFound.message}`, { cause: ErrNotFound }));
        }
        if (parentID !== '') {
            const parent = this.rows.get(parentID);
            if (parent === undefined) {
                return Promise.reject(new Error(`${parentID}: ${ErrNotFound.message}`, {
                    cause: ErrNotFound,
                }));
            }
            const bad = checkParent(t.kind, parent);
            if (bad !== undefined) {
                return Promise.reject(bad);
            }
            if (this.tree().hasDescendant(id, parentID)) {
                return Promise.reject(cycleError(id, parentID));
            }
        }
        const moved = t.clone();
        moved.parentID = parentID;
        moved.position = position;
        moved.updatedAt = at;
        this.rows.set(id, moved);
        return Promise.resolve();
    }
    children(parentID) {
        return Promise.resolve(this.tree().children(parentID));
    }
    subtree(id) {
        const found = this.tree().subtree(id);
        if (found.length === 0) {
            return Promise.reject(new Error(`${id}: ${ErrNotFound.message}`, { cause: ErrNotFound }));
        }
        return Promise.resolve(found);
    }
    availability(at, ...ids) {
        for (const id of ids) {
            this.calls.push({ op: 'availability', id });
        }
        return Promise.resolve(this.tree().availabilityOf(at, ...ids));
    }
    purge() {
        return Promise.reject(new Error('purge is not used by these tests'));
    }
    purgeSubtree() {
        return Promise.reject(new Error('purgeSubtree is not used by these tests'));
    }
    tags() {
        return Promise.resolve([]);
    }
    setTagStatus() {
        return Promise.reject(new Error('setTagStatus is not used by these tests'));
    }
    renameTag() {
        return Promise.reject(new Error('renameTag is not used by these tests'));
    }
    removeTag() {
        return Promise.reject(new Error('removeTag is not used by these tests'));
    }
    addEvent() {
        return Promise.reject(new Error('events are not used by these tests'));
    }
    getEvent() {
        return Promise.reject(new Error('events are not used by these tests'));
    }
    findEventByPrefix() {
        return Promise.reject(new Error('events are not used by these tests'));
    }
    events() {
        return Promise.resolve([]);
    }
    updateEvent() {
        return Promise.reject(new Error('events are not used by these tests'));
    }
    removeEvent() {
        return Promise.reject(new Error('events are not used by these tests'));
    }
    setWaits() {
        return Promise.reject(new Error('events are not used by these tests'));
    }
    waits() {
        return Promise.resolve([]);
    }
    savePerspective() {
        return Promise.reject(new Error('savePerspective is not used by these tests'));
    }
    perspective() {
        return Promise.reject(new Error('perspective is not used by these tests'));
    }
    perspectives() {
        return Promise.resolve([]);
    }
    deletePerspective() {
        return Promise.reject(new Error('deletePerspective is not used by these tests'));
    }
    describe() {
        return 'an in-memory store';
    }
    ping() {
        return Promise.resolve();
    }
    close() {
        return Promise.resolve();
    }
}
//# sourceMappingURL=testsupport.js.map