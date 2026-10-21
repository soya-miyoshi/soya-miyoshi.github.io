// The slice of the DOM this app touches, declared here instead of pulled in.
//
// This looks like a strange thing to hand-write, so here is why it is. One
// `tsconfig.json` covers every package in this repository (`MIGRATION.md`,
// "No build step"), and it compiles with the default libraries for its
// target — no `dom`. Adding `lib: ["dom"]` is not a local change: the DOM
// library declares `fetch`, `Response`, `Request` and `Headers` as globals,
// and so does `@types/node`, which `packages/cli` and both Node stores are
// checked against. Switching it on for the whole program to type eleven
// property reads in one module is the wrong direction, and the alternative —
// a second `tsconfig.json` with its own libraries — is the per-package build
// that `MIGRATION.md` records as tried and abandoned.
//
// So the interfaces below are the contract this module asserts about the
// browser, and `document()` is the single unchecked cast that buys it. They
// are deliberately the narrowest shape that compiles: anything this app
// starts doing to the page has to be added here first, which is a cheap
// reminder that the viewer's markup is in `public/`, not in TypeScript.
//
// `fetch`, `Response` and `Request` are *not* here. Those are declared by
// `@types/node` as well as by browsers, with the same shapes, so `router.ts`
// and `shim.ts` are type-checked against the Node declarations and run
// against the browser ones.
/**
 * document returns the page, or undefined when there is none — which is the
 * case under `node --test`, where every module but this one is exercised
 * without a browser. A caller that cannot work without a page does nothing,
 * rather than throwing from a module's top level.
 */
export function document(global = globalThis) {
    const doc = global.document;
    if (doc === null || doc === undefined) {
        return undefined;
    }
    return doc;
}
/**
 * pageScheme is `location.protocol`: `https:` or `http:`, and the empty
 * string where there is no location. It is read through here so that
 * `credentials.mixedContent` takes a string and stays testable.
 */
export function pageScheme(global = globalThis) {
    const loc = global.location;
    const scheme = loc?.protocol;
    return typeof scheme === 'string' ? scheme : '';
}
/**
 * workers returns `navigator.serviceWorker`, or undefined where there is no
 * navigator (`node --test`) and where the browser has no service worker
 * support or withholds it outside a secure context. Every caller treats the
 * absence as "no updates to notice", which is the truthful reading.
 */
export function workers(global = globalThis) {
    const nav = global.navigator;
    const sw = nav?.serviceWorker;
    if (sw === null || sw === undefined) {
        return undefined;
    }
    return sw;
}
/** reloader returns `location`, or undefined where there is none. */
export function reloader(global = globalThis) {
    const loc = global.location;
    if (loc === null || loc === undefined) {
        return undefined;
    }
    return loc;
}
//# sourceMappingURL=dom.js.map