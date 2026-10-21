// The seam between the page and the store: a `fetch` that answers `/api/*`
// from this tab instead of from a server.
//
// `public/app.js` is `packages/cli/assets/app.js`, byte for byte, and it is
// going to stay that way — it is the viewer the project already has, laid out
// the way it wants to be laid out, and a second copy that drifts is the
// failure mode this whole migration was about. Its only coupling to a server
// is one function:
//
//     const res = await fetch(path, init);
//
// `fetch` there is a global resolved at call time, so replacing the global is
// what lets an unmodified `app.js` talk to a store that is in the same tab.
// The alternatives were worse: editing the copy means maintaining a fork of a
// 750-line file to change six lines of it, and a `Service Worker` answering
// `/api` means the credential has to be handed to a worker that outlives the
// page — the one place in this design where a token would be written somewhere
// nobody can see it.
//
// Two rules keep the replacement honest. Everything that is not `/api/…` on
// this origin goes to the captured original, unexamined; and the original is
// captured before the replacement is installed and handed to
// `@todocloud/store-turso` directly, so the provider's requests never pass
// through this module at all. A credential therefore never travels through
// the shim, and an interceptor bug cannot redirect one.
import { httpError } from "./router.js";
/**
 * apiPrefix is the one path space this module answers. `app.js` builds every
 * request path from a root-anchored literal, so the match is on the pathname
 * and the page's own scope does not enter into it.
 */
export const apiPrefix = '/api/';
/**
 * Shim is the installed interceptor. It holds the router it dispatches to in
 * one mutable slot, because connecting and disconnecting a store happens
 * many times in the life of a page and replacing the global every time would
 * leave a chain of wrappers behind.
 */
export class Shim {
    /** original is the runtime's own fetch, captured before installation. */
    original;
    target;
    constructor(original) {
        this.original = original;
    }
    /** connect points the shim at a store's router. */
    connect(router) {
        this.target = router;
    }
    /** disconnect leaves the shim installed and answering with 503. */
    disconnect() {
        this.target = undefined;
    }
    /** connected reports whether a store is behind the shim. */
    connected() {
        return this.target !== undefined;
    }
    /**
     * fetch is the replacement global. It is a bound property rather than a
     * method so that `globalThis.fetch = shim.fetch` keeps working — a caller
     * invoking the global gets `undefined` for `this`.
     */
    fetch = async (input, init) => {
        const url = urlOf(input, init);
        if (url === undefined || !url.pathname.startsWith(apiPrefix)) {
            return this.original(input, init);
        }
        const router = this.target;
        if (router === undefined) {
            // 503 and the `config` code, which is what `statusOf` gives a store
            // that is not usable yet, and what the CLI reports as exit 3. The page
            // shows the message, so it says what to do.
            return httpError(503, 'config', 'this app is not connected to a database yet; enter your Turso URL and token');
        }
        const method = methodOf(input, init);
        return router.handle(method, url.pathname, bodyOf(input, init));
    };
}
/**
 * install replaces the global `fetch` and returns the shim, which holds the
 * original. Nothing uninstalls it: the page lives as long as the tab, and a
 * global that comes and goes is harder to reason about than one that is
 * replaced once at boot.
 */
export function install(global) {
    const original = global.fetch;
    if (typeof original !== 'function') {
        throw new Error('this browser has no fetch, which this app is built on');
    }
    const shim = new Shim(original.bind(global));
    global.fetch = shim.fetch;
    return shim;
}
/**
 * urlOf resolves whatever `fetch` was given against the page, returning
 * undefined when it cannot be resolved — a `Request` built elsewhere, a
 * specifier this module has no base for. Undefined means "not ours", so an
 * unrecognised argument is passed through rather than guessed at.
 */
function urlOf(input, _init) {
    try {
        if (typeof input === 'string') {
            return new URL(input, base());
        }
        if (input instanceof URL) {
            return input;
        }
        if (typeof Request !== 'undefined' && input instanceof Request) {
            return new URL(input.url, base());
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
/**
 * base is what a relative path resolves against. `location` is absent under
 * `node --test`, where the tests drive the shim with absolute paths anyway,
 * so a placeholder stands in: it is never reached by a network request,
 * because this module makes none.
 */
function base() {
    const loc = globalThis.location;
    return loc?.href ?? 'http://localhost/';
}
function methodOf(input, init) {
    const given = init?.method;
    if (typeof given === 'string' && given !== '') {
        return given.toUpperCase();
    }
    if (typeof Request !== 'undefined' && input instanceof Request) {
        return input.method.toUpperCase();
    }
    return 'GET';
}
/**
 * bodyOf reads the request body as text. Only a string body is understood,
 * which is all `app.js` sends — it `JSON.stringify`s every payload. Anything
 * else reads as absent, and the handler then refuses a request that needed a
 * body, which is the correct answer for a body this module cannot see.
 *
 * Undefined and the empty string are kept apart, because `optionalBody` in
 * `api.ts` turns on exactly that difference.
 */
function bodyOf(_input, init) {
    const body = init?.body;
    if (typeof body === 'string') {
        return body;
    }
    return undefined;
}
//# sourceMappingURL=shim.js.map