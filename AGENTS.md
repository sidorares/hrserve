# AGENTS.md

Guidance for AI agents (and new contributors) working on hrserve.

## What this project is

hrserve is a hot-reload development server with an unusual architecture: **the browser is the server**. There is no HTTP listener. Instead:

1. The caller launches Chromium via Playwright (`bin/hrserve.ts` does this for the CLI).
2. `createServer(browser).serve({ url, dir })` opens a page and intercepts all requests with `page.route("**/*")`. `GET` requests whose origin + path fall under the base `url` are answered from local files in `dir`; everything else goes to the real network. This means local files can be overlaid onto any URL, including a production origin, and the fake host never needs to resolve in DNS.
3. Every served file with a known patcher is watched with chokidar. On change, the page is **patched in place** over a Chrome DevTools Protocol (CDP) session — the page never reloads and keeps its JS state.

## File map

- `lib/hrserve.ts` — the core. `createServer()` sets up per-MIME-type patchers, the CDP session, request routing, and file watchers. Public API: `serve()`, `close()`, events `patch` / `new-resource`.
- `lib/rules.ts` — the routing rule table: user-facing `Rule` types (`serve` / `upstream` / `proxy`), normalization (defaults, validation) and glob matching via picomatch. Rules are ordered, first match wins, matched against the path relative to the base URL.
- `lib/resolve-request.ts` — pure-ish mapping from a request URL to a decision: serve a file, proxy, run a mock route, fall back to serve-handler (listing/404), 404, or pass through to the network. All URL/path edge cases live here; it is unit-tested.
- `lib/mock-routes.ts` — pure Next.js-style file-route discovery and matching (segment parsing, specificity ordering, param extraction). No module loading, so the subtle matching rules are unit-testable on their own.
- `lib/mock-router.ts` — the mock runtime: loads handler modules through jiti, executes App Router (`route.ts` exporting GET/POST/…) and Pages Router (`(req, res)` default export) handlers, and watches for edits.
- `lib/session-manager.ts` — runs several named sessions in one browser, each in its own context, each buffering console/network/patch history. This is what lets N worktrees be served at the *same* URL at once.
- `lib/mcp-server.ts` — exposes sessions over MCP so agents can start them and inspect the resulting pages. `hrserve mcp` runs it over stdio.
- `lib/serve-directory.ts` — bridges serve-handler (which expects Node `IncomingMessage`/`ServerResponse`) onto a Playwright `Route` with mock request/response objects. Used for directory listings and 404 pages.
- `lib/reload-image.ts` — an in-page function (run via `page.evaluate`) that cache-busts every reference to a changed image: `<img>`, `srcset`, CSS rules, inline styles, SVG `<image>`, favicons, etc.
- `lib/types.d.ts` — hand-written declaration for `csstree-validator` (no upstream types).
- `bin/hrserve.ts` — yargs CLI wrapper.

## How patching works (per MIME type)

| Type | Mechanism |
|------|-----------|
| `text/css` | Validate with csstree-validator, then `CSS.setStyleSheetText` using the styleSheetId captured from `CSS.styleSheetAdded` events |
| JS (`application/javascript` **and** `text/javascript`) | Try `Debugger.setScriptSource` (LiveEdit), then always dispatch a `script-patch` CustomEvent on `window` |
| `text/html` | `DOM.getDocument` + `DOM.setOuterHTML` on the root node |
| `image/*` | `reloadImage()` rewrites URLs in the live DOM/CSSOM with a `_t=<timestamp>` cache buster |

The `patch` event is emitted **once per file change by the watcher callback** in `serve()` — patchers themselves must not emit it (that caused double events historically).

## Hard-won invariants — do not regress these

- **CDP ids are session-scoped.** `styleSheetId`s from `CSS.styleSheetAdded` and script ids from `Debugger.scriptParsed` are only valid on the CDP session whose `enable()` produced them — the one created in `serve()` and passed to patchers via `PatchContext`. Creating a fresh `page.context().newCDPSession(page)` inside a patcher yields "No style sheet with given id found". Always use `ctx.cdp`.
- **Chromium removed LiveEdit.** Live editing of JavaScript sources was [deprecated in Chrome 142 and removed in Chrome 145](https://developer.chrome.com/blog/devtools-deprecates-live-editing) (Feb 2026); `Debugger.setScriptSource` now fails with "setScriptSource functionality no longer available". The JS patcher treats it as best-effort and relies on the `script-patch` event as the stable contract. A real replacement (e.g. ESM re-import, per the same announcement's "HMR is superior" rationale) is an open design question.
- **`page.evaluate` serializes the function source.** The big function in `reload-image.ts` must stay fully self-contained: helpers defined inside it, no references to module scope (closures don't survive serialization). Additionally, esbuild-based runners (tsx) inject `__name(...)` helper calls when transpiling, so `reloadImage` installs a no-op `globalThis.__name` shim in the page first. `tsc` output doesn't need the shim, tsx does (`npm run dev:ts`, tests).
- **CSSOM property names are hyphenated.** `style.getPropertyValue()`/`setProperty()` silently ignore camelCase names like `backgroundImage`; use `background-image`. (camelCase worked only for *reading* via property access, which hid the broken write.)
- **URL matching must be segment-aware.** `resolve-request.ts` compares parsed origin + pathname, not string prefixes — `http://localhost:3000` must not capture `http://localhost:30001`, and base `/app` must not capture `/apple`. Paths are percent-decoded before hitting the filesystem, with a containment check because encoded slashes (`%2f`) survive URL normalization and could otherwise escape `dir`.
- **serve-handler's response contract is messy.** It both assigns `response.statusCode` directly *and* calls `writeHead()`, and mixes `setHeader()` with `writeHead()` headers. The mock in `serve-directory.ts` keeps a real `statusCode` property and merges (never replaces) headers. It receives the raw **URL path** (e.g. `/sub/`), not a filesystem path — serve-handler does its own decoding.
- **mime-db has flip-flopped on `.js`** between `application/javascript` and `text/javascript`; the JS patcher is registered under both keys.
- **jiti caches modules in Node's global `require.cache`.** Creating a fresh jiti instance does *not* give you a fresh module — the cache entries have to be deleted by path (`MockRouter.resetModules`). This is what makes mock hot-reload work while still letting handlers keep in-memory state between requests.
- **`chokidar.watch()` misses changes made before its "ready" event** when `ignoreInitial: true` — the initial scan window silently swallows them. Both `MockRouter.start()` and the per-file watchers in `serve()` await `ready` for this reason; without it, an edit made right after startup is simply lost. In `serve()` the wait happens *after* `route.fulfill`, so it costs the page nothing.
- **chokidar collapses two writes to the same file that land in the same mtime tick into one event.** Editing a file twice in quick succession produces a single patch, which is why tests that patch the same file twice space the writes out. Real editing is nowhere near that fast, but automated writes are.
- **stdout is the MCP protocol stream.** `hrserve mcp` redirects `console.log` to stderr because a stray log from a user's mock handler would otherwise corrupt the session. Keep diagnostics on `console.warn`/`console.error`, or behind the verbose `log()`.
- **Proxying must use `route.fetch()` + `route.fulfill()`, never `route.continue({ url })`.** Playwright accepts a cross-origin `continue({ url })` without complaint, but the browser then applies CORS to the response and the page gets "Failed to fetch" — verified, and the reason the proxy rule is implemented the way it is. Fetching from Node and fulfilling locally keeps the response same-origin from the page's perspective.

## Commands

```bash
npm ci                       # install (also: npx playwright install chromium, once)
npm run build                # tsc → dist/ (this is also the type check)
npm test                     # test:unit + test:browser
npm run test:unit            # node:test via tsx, no browser needed
npm run test:browser         # headless-Chromium integration tests
npm run lint                 # biome check .
npm run lint:fix             # biome check --write .
npm run dev:ts               # run the CLI from TS sources (tsx)
```

Tests use the built-in `node:test` runner with `tsx` for TypeScript — no test framework dependency. Browser tests create throwaway fixture directories, serve them at fake `*.hrserve.test` origins (never resolved — route interception answers everything), and assert against the live page. If you touch patching logic, run `npm run test:browser`; unit tests alone cannot catch CDP regressions.

## Releases & commit style

Releases are automated with release-please (`.github/workflows/cd-publish.yml`, see `RELEASE.md`). **Commit messages and PR titles must follow Conventional Commits** (`feat:`, `fix:`, `test:`, `chore:`...) — they drive the version bump and changelog. Merging the auto-generated release PR publishes to npm (`prepublishOnly` builds `dist/`; only `dist` ships, see `files` in package.json). Publishing authenticates via npm trusted publishing (OIDC) — no token secret; the trusted publisher is registered on npmjs.com against `cd-publish.yml`, so renaming that workflow file breaks publishing until the npm-side setting is updated.

CI (`.github/workflows/ci.yml`) runs lint, build, and both test suites on every PR.

## Known quirks / open ends

- `ServeOptions.devtools` is deprecated and ignored — devtools can only be enabled at browser launch (the CLI passes `--auto-open-devtools-for-tabs`; the old Playwright `devtools` launch option was removed).
- Watchers are keyed by full request URL, so the same file requested with different query strings gets multiple watchers. Harmless, but not deduplicated.
- The `watchEvent("DOM.*")` listeners in `serve()` only log (behind `verbose`); they are a placeholder for bidirectional sync ("Edit as HTML" in devtools → write back to disk, [issue #12](https://github.com/sidorares/hrserve/issues/12)).
- Existing files with no recognized extension (e.g. `LICENSE`) return 404 rather than a generic binary type.
- CSS `@import`-ed and `@media`-nested rules are not traversed by `reloadImage`.
