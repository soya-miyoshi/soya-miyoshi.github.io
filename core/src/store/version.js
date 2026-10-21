// The schema-version seam: the sentinel, the error that carries the detail,
// the two optional capabilities a provider may have, and the migration plan
// the command layer shows before it changes anything.
//
// Port notes:
//
//   - Go's `(*VersionError).Is` made `errors.Is(err, ErrSchemaMismatch)` true
//     for every VersionError. Here `VersionError` carries ErrSchemaMismatch as
//     its `cause`, so the chain walk in `isSchemaMismatch` finds it the same
//     way, and `exit.classify` needs to know about only the sentinel.
//   - Go's optional interfaces were type assertions on Store. They are
//     structural here, which is what a TypeScript interface already is: a
//     provider implements VersionChecker by having a `checkSchema` method, and
//     `checkSchema` below tests for it rather than requiring a declaration.
import { Version, pending } from "./schema.js";
import { isNotInitialized } from "./store.js";
/**
 * ErrSchemaMismatch is reported when the store's schema version is not the
 * one this build writes. It is a configuration problem, exit 3, and the
 * message always says what to do about it: migrate the store when it is
 * older, upgrade the binary when it is newer.
 *
 * It exists as a sentinel so that the command layer can branch without
 * parsing prose and so that no raw SQL error ever reaches the user in its
 * place: a binary that ran a query against a schema it does not understand
 * would at best fail oddly and at worst answer wrongly.
 */
export const ErrSchemaMismatch = new Error("the store's schema version is not the one this tdo expects");
/** Reports whether err, or anything it wraps, is ErrSchemaMismatch. */
export function isSchemaMismatch(err) {
    const seen = new Set();
    let cur = err;
    while (cur !== null && cur !== undefined && !seen.has(cur)) {
        if (cur === ErrSchemaMismatch) {
            return true;
        }
        seen.add(cur);
        cur = typeof cur === 'object' && 'cause' in cur ? cur.cause : undefined;
    }
    return false;
}
/** VersionError is the detail behind ErrSchemaMismatch. */
export class VersionError extends Error {
    name = 'VersionError';
    /**
     * store is the provider's own description of where the data is. It is
     * credential-free: it is whatever describe returns.
     */
    store;
    /**
     * found is the version recorded in the store, want the one this build
     * writes.
     */
    found;
    want;
    constructor(store, found, want) {
        super(VersionError.describe(store, found, want), {
            cause: ErrSchemaMismatch,
        });
        this.store = store;
        this.found = found;
        this.want = want;
    }
    /**
     * older reports whether the store is behind the binary, which is the case
     * `tdo migrate` fixes.
     */
    older() {
        return this.found < this.want;
    }
    static describe(store, found, want) {
        if (found < want) {
            return `${store} is at schema version ${found} and this tdo expects ${want}; run \`tdo migrate\` to upgrade it`;
        }
        return `${store} is at schema version ${found} and this tdo only understands ${want}; upgrade tdo`;
    }
}
/**
 * checkVersion compares a version read from a store with the one this build
 * writes and returns a VersionError when they differ, or undefined when they
 * agree. Go returned an `error`; the caller raises it.
 */
export function checkVersion(found, describe) {
    if (found === Version) {
        return undefined;
    }
    return new VersionError(describe, found, Version);
}
function isVersionChecker(s) {
    return typeof s.checkSchema === 'function';
}
/**
 * checkSchema verifies that s holds the schema this build writes, throwing
 * when it does not.
 *
 * This is the seam every command uses. It raises ErrNotInitialized for a
 * store with no schema (exit 3, "run `tdo init`"), ErrSchemaMismatch for one
 * at the wrong version (exit 3, with the right advice either way), and
 * returns normally when the store can be used. A command that skips it can
 * return a wrong answer against a schema it does not understand, which is
 * worse than an error.
 *
 * It is cheap: a provider that already knows the version answers from what
 * it has. For turso that is the probe openExisting makes, so a checked
 * command costs exactly the round trips an unchecked one did.
 */
export async function checkSchema(s) {
    if (isVersionChecker(s)) {
        return s.checkSchema();
    }
    const v = await s.schemaVersion();
    const err = checkVersion(v, s.describe());
    if (err !== undefined) {
        throw err;
    }
}
function isBackupper(s) {
    return typeof s.backupForMigration === 'function';
}
/**
 * planMigration reads the store's version, refuses one written by a newer
 * binary, and — for a provider that can — takes the backup, before any step
 * runs. The command layer calls it, shows the user what it says, and then
 * calls migrate.
 *
 * The backup is taken here, not inside migrate, so that the path can be
 * printed before the risky part starts: a user watching a migration fail
 * should already have been told where the copy is.
 */
export async function planMigration(s) {
    const plan = {
        store: s.describe(),
        from: 0,
        to: Version,
        upToDate: false,
        steps: [],
        backupPath: '',
        confirm: false,
        warning: '',
    };
    let current = 0;
    let initialized = false;
    try {
        current = await s.schemaVersion();
        initialized = true;
    }
    catch (err) {
        if (!isNotInitialized(err)) {
            throw err;
        }
        // A store with no schema is not a migration; migrate creates one.
        current = 0;
    }
    plan.from = current;
    if (current > Version) {
        throw new VersionError(plan.store, current, Version);
    }
    if (current === Version) {
        plan.upToDate = true;
        return plan;
    }
    for (const step of pending(current)) {
        plan.steps.push(step.name);
    }
    // An uninitialized store holds nothing to lose, so neither the backup nor
    // the confirmation applies to it. The test is whether there was a schema to
    // read, not whether the version came back as zero: a store that somehow
    // recorded version 0 still has rows in it.
    if (!initialized) {
        return plan;
    }
    if (!isBackupper(s)) {
        plan.confirm = true;
        plan.warning =
            `${plan.store} is remote: tdo cannot take a backup of it, and a ` +
                `migration cannot be undone. Take your provider's own snapshot first ` +
                `if you want one.`;
        return plan;
    }
    plan.backupPath = await s.backupForMigration(current);
    return plan;
}
//# sourceMappingURL=version.js.map