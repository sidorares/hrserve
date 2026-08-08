# hrserve

A development server that serves web pages and automatically patches file changes without full page reloads using Playwright.

Instead of running an HTTP server, hrserve launches a Chromium browser and intercepts its network requests: `GET` requests under the base URL are answered from a local directory, and every served file is watched. When a file changes, the running page is patched in place over the Chrome DevTools Protocol — no reload, no lost state.

📚 **[Full documentation](https://sidorares.github.io/hrserve/)** — including [MCP setup for Claude Code, Cursor and VS Code](https://sidorares.github.io/hrserve/mcp-integration).

## CLI Usage

```bash
npx hrserve [dir] --url http://localhost:3000/
```

Options:
- `--url`: Base URL of the page (default: `http://localhost:3000/`)
- `--mock-dir`: Directory of file-based [mock API routes](#mock-api-routes), run in-process
- `--mock-path`: Path glob handled by `--mock-dir` / `--proxy` (default: `/api/**`)
- `--proxy`: Send `--mock-path` requests without a mock route to this origin
- `--profile`: Start from a saved [profile](#session-profiles)'s cookies and storage
- `--save-profile`: On Ctrl-C, save this session's cookies and storage under this name
- `--devtools, -d`: Run with devtools initially open
- `--verbose, -v`: Run with verbose logging
- `--width, -w`: Width of the browser window
- `--height, -h`: Height of the browser window

## Programmatic Usage

```javascript
import { chromium } from "playwright";
import { createServer } from "hrserve";

async function example() {
  // Create browser
  const browser = await chromium.launch({
    headless: false,
  });

  // Create server
  const server = createServer(browser);

  // Listen for patch events
  server.on("patch", ({ fileName, url, mimeType }) => {
    console.log(`File patched: ${fileName} (${mimeType})`);
  });

  // Start serving
  const page = await server.serve({
    url: "http://your-project-host.com/",
    dir: "./public",
    width: 1200,
    height: 800,
  });
}
```

### API

#### `createServer(browser)`

Creates a new hrserve instance.

**Parameters:**
- `browser`: A Playwright browser instance

**Returns:** Server object with the following methods:

#### `server.serve(options)`

Starts serving files and watching for changes. Resolves with the Playwright `Page` after the initial navigation.

**Parameters:**
- `options.url`: The base URL to serve
- `options.dir`: Directory to serve files from (optional when every rule sets its own `dir`)
- `options.rules`: Ordered routing rules — see [Routing rules](#routing-rules)
- `options.width`: Browser window width (default: 1280)
- `options.height`: Browser window height (default: 720)
- `options.profile`: Name of a saved [profile](#session-profiles) to start from (default: a fresh session)
- `options.verbose`: Log request routing and CDP events (default: false)

#### `server.saveProfile(name)`

Snapshots the current session's cookies and storage as a named [profile](#session-profiles). Resolves with a summary (`name`, `parent`, `capturedAt`, `origins`, `cookieDomains`).

#### `server.close()`

Stops watching files. Does not close the browser — the caller owns it.

#### `server.on(event, handler)`

Listen for server events.

**Events:**
- `'patch'`: Emitted once per file change. Handler receives `{ fileName, url, mimeType, applied, reason }`. `applied: false` means the change was seen but deliberately *not* put into the page — `reason` says why (`css-invalid`, `stylesheet-not-loaded`, `live-edit-unavailable`, …)
- `'request'`: Emitted for every intercepted request, with `{ url, method, kind }` where `kind` is the routing decision (`file`, `mock`, `proxy`, `pass`, `fallback`, …)
- `'new-resource'`: Emitted when a served file starts being watched. Handler receives `{ url, mimeType }`

## Routing rules

By default every `GET` under the base URL is served from `dir`. Pass `rules` to mix local files with real network traffic — an ordered list, **first match wins**:

```javascript
await server.serve({
  url: "https://app.example.com/",
  dir: "./dist",
  rules: [
    { match: "/assets/**", action: "serve", dir: "./dist/assets" },
    { match: "/api/**", action: "proxy", target: "https://staging-api.example.com" },
    { match: "/health", action: "upstream" },
    { match: "**", action: "serve" },
  ],
});
```

`match` is a glob ([picomatch](https://github.com/micromatch/picomatch) syntax) tested against the request path **relative to the base URL**, so with a base of `https://app.example.com/` the rule `/api/**` matches `https://app.example.com/api/users`. It defaults to `**`. An optional `methods: ["POST"]` narrows a rule to specific HTTP methods.

**Actions:**

- `serve` — answer from `dir` (falling back to a directory listing or 404 page). Only `GET`/`HEAD`; other methods go to the network. Served files are watched and patched as usual. `dir` defaults to the top-level `dir`, and mirrors the URL space beneath it.
- `upstream` — let the request through to the real network, untouched.
- `proxy` — send the request to `target`, preserving path, query, method, headers and body. hrserve performs this request itself and returns the result as if it came from the page's own origin, **so the page is not subject to CORS**. A path prefix on the target is kept: target `https://example.com/v2` + request `/api/users` → `https://example.com/v2/api/users`. If the target is unreachable the page gets a 502.

- `mock` — answer from file-based API routes executed **in this process** (see below). If no mock route matches the path, the request falls through to the **next** rule.

Requests matching **no** rule go to the network, so a rule list without a `**` entry is an overlay rather than a full server.

## Mock API routes

Point a `mock` rule at a directory of route files and hrserve runs them in-process — no port, no spawned server, no framework:

```bash
npx hrserve ./public --url http://localhost:3000/ --mock-dir ./mocks --proxy https://staging-api.example.com
```

```javascript
await server.serve({
  url: "http://localhost:3000/",
  dir: "./public",
  rules: [
    { match: "/api/**", action: "mock", dir: "./mocks" },
    // anything the mocks don't cover reaches the real API
    { match: "/api/**", action: "proxy", target: "https://staging-api.example.com" },
    { match: "**", action: "serve" },
  ],
});
```

The directory mirrors the URL space, following **Next.js file conventions**, so you can point it at a `mocks/` folder *or* straight at a real Next app's `app/` or `pages/` directory:

| File (relative to the mock dir) | URL |
|---|---|
| `api/users/route.ts` | `/api/users` |
| `api/users/[id]/route.ts` | `/api/users/:id` |
| `api/files/[...path]/route.ts` | `/api/files/*` (one or more segments) |
| `api/docs/[[...slug]]/route.ts` | `/api/docs` and `/api/docs/*` |
| `api/users.ts` (pages style) | `/api/users` |
| `api/posts/index.ts` | `/api/posts` |

Resolution follows Next's priority — static beats dynamic beats catch-all — so `/api/users` wins over `/api/[id]`. Route groups `(admin)` and parallel routes `@modal` don't affect the URL, and App Router UI files (`page`, `layout`, `loading`, …) plus `_`-prefixed files are ignored.

**App Router style** — a `route.ts` exporting HTTP method functions, using Web `Request`/`Response`:

```typescript
const todos = [{ id: 1, title: "write tests" }];

export function GET() {
  return Response.json(todos);
}

export async function POST(request: Request) {
  const { title } = await request.json();
  const todo = { id: todos.length + 1, title };
  todos.push(todo);                       // module state survives between requests
  return Response.json(todo, { status: 201 });
}

// Dynamic segments arrive as params; both styles work
export async function PATCH(request: Request, ctx: { params: { id: string } }) {
  const { id } = await ctx.params;        // Next 15 style
  return Response.json({ id });
}
```

**Pages Router style** — a default export taking `(req, res)`, with `req.query`, `req.body` (JSON and urlencoded bodies are parsed) and `res.status().json()/.send()/.setHeader()/.redirect()`.

TypeScript handlers run through [jiti](https://github.com/unjs/jiti), so no build step is needed. `HEAD` falls back to `GET`, `OPTIONS` is answered automatically, and an unexported method returns 405 with an `Allow` header.

**Hot reload:** editing a handler takes effect on the next request. Module-level state (an in-memory list, a counter) is preserved *between* requests and reset when the file changes. Adding or deleting route files re-scans automatically.

This is a mock layer, not a Next.js runtime — `middleware.ts`, the edge runtime, ISR/SSG, and `next/headers`-style request context are out of scope.

## Parallel sessions and MCP (for agents)

Because an hrserve origin is a **name inside a browser context, not a socket**, several sessions can serve *the same* URL simultaneously. That removes the usual blocker for running many agents at once: git worktrees handle the code, but conventional dev servers still need a port each. Here every worktree is `http://app.hrserve.test/`, in its own isolated context.

```javascript
import { SessionManager } from "hrserve/dist/lib/session-manager.js";

const manager = new SessionManager({ browser });
await manager.start({ name: "feature-a", dir: "~/wt/feature-a" });
await manager.start({ name: "feature-b", dir: "~/wt/feature-b" }); // same URL, no conflict
```

Each session buffers its own console output, request log and patch history.

### MCP server

```bash
npx hrserve mcp          # stdio MCP server; --headed to watch the browser
```

Register it with an MCP-capable agent and it can serve a worktree and then *verify its own edits* — the thing an agent otherwise can't do:

| Tool | What it answers |
|---|---|
| `serve_start` / `serve_list` / `serve_stop` | session lifecycle, one per worktree |
| `page_screenshot` | "what does it look like now?" |
| `page_console` | "did my change break anything?" (console + uncaught errors) |
| `page_network` | "why did that request return that?" — each entry labelled `served-local`, `mocked`, `proxied`, `upstream` or `blocked` |
| `patch_history` | "did my edit reach the page?" — with `applied` and, when false, the reason (invalid CSS, stylesheet not loaded, LiveEdit unavailable) |
| `wait_for_patch` | block until the next patch lands, instead of polling |
| `page_dom` | text or HTML snapshot for non-visual assertions |
| `page_eval` | run an expression in the page |
| `page_reload`, `set_viewport` | discard patched state; check a responsive layout |

⚠️ **Trust model:** `page_eval` runs arbitrary JavaScript in the page and mock handlers are ordinary modules executed in this process, so an MCP client with access to this server can run code on your machine. Only connect clients you would already trust with a shell.

### In-page events

When a watched JavaScript file changes, hrserve dispatches a `script-patch` `CustomEvent` on `window` so page code can react (e.g. re-run initialization):

```javascript
window.addEventListener("script-patch", (event) => {
  console.log("changed:", event.detail.scriptUrl);
});
```

## Session profiles

Every session starts in a fresh browser context, which is usually what you want — but not when getting to the interesting page means logging in or clearing a captcha by hand. A **profile** saves that work so later sessions can start from it.

```bash
npx hrserve ./public --url https://app.example.com/ --save-profile prod-login
#   ... log in in the browser window, then press Ctrl-C to capture ...

npx hrserve ./public --url https://app.example.com/ --profile prod-login   # already logged in
npx hrserve profiles                                                       # list what's saved
```

Programmatically:

```javascript
const server = createServer(browser);
await server.serve({ url: "https://app.example.com/", dir: "./dist", profile: "prod-login" });
// ...do more manual steps in the page...
await server.saveProfile("prod-login-2fa");
```

### Profiles are immutable snapshots

A profile is one JSON file holding Playwright's `storageState`: cookies, per-origin localStorage and IndexedDB. Sessions **read** profiles and never write back — `saveProfile()` is the only way state is persisted, and it always writes a *new* name.

That single rule is what makes branching trivial and safe:

```
serve(--save-profile A)            # fresh; log in by hand → A
serve(--profile A)                 # B starts from A
serve(--profile A) → save as C     # C starts from A too, concurrently, and adds more
serve(--profile C)                 # D starts from C
```

Two sessions can run from the same profile at the same time without interfering, and starting from `A` gives the same result no matter what `C` did afterwards. There is no `fork` command because forking *is* "start from X, save as Y". Each profile records the `parent` it branched from, shown by `hrserve profiles` — that lineage is descriptive only; every snapshot is complete on its own.

### Two things to know

- **A profile is a credential file.** It contains live session cookies, so profiles are stored per-user outside your project — `$XDG_DATA_HOME/hrserve/profiles/` (default `~/.local/share/hrserve/profiles/`), mode `0600`. Never commit one.
- **Profiles are origin-scoped.** `storageState` belongs to the origins it was captured on, and hrserve deliberately serves at arbitrary origins — a profile captured on `https://app.example.com` does nothing for a session served at `http://app.hrserve.test/`. hrserve warns when the profile doesn't cover the URL you're serving, because the alternative is a silently logged-out page.

A profile carries what `storageState` carries. It does **not** capture sessionStorage, service worker caches, HTTP auth, WebAuthn credentials or browser extensions — those need a persistent browser user-data directory, which cannot be shared between concurrent sessions and so is deliberately out of scope here.

## Supported File Types

- **CSS**: Live updates via `CSS.setStyleSheetText` — no page reload (changes are validated first; invalid CSS is not applied)
- **JavaScript**: A `script-patch` event is dispatched on the page. On Chromium versions that still support LiveEdit ([removed in Chrome 145](https://developer.chrome.com/blog/devtools-deprecates-live-editing)), the running script's body is also swapped via `Debugger.setScriptSource`
- **HTML**: Full DOM replacement via `DOM.setOuterHTML`
- **Images**: Automatic image reload with cache busting (PNG, JPG, GIF, SVG, WebP) — covers `<img>`, `srcset`, `<picture>` sources, CSS `background-image` and friends, inline styles, SVG `<image>`, favicons, `<object>`/`<embed>` and `<input type="image">`

Requests under the base URL that do not map to a served file fall back to [serve-handler](https://github.com/vercel/serve-handler) for directory listings and 404 pages. Requests outside the base URL go to the network as usual.

## Development

```bash
npm ci
npx playwright install chromium   # needed once for browser tests
npm run build        # type-check and compile to dist/
npm test             # unit + browser tests
npm run lint         # biome
npm run dev:ts       # run the CLI from TypeScript sources
```

See [AGENTS.md](AGENTS.md) for architecture notes.
