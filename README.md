# hrserve

A development server that serves web pages and automatically patches file changes without full page reloads using Playwright.

Instead of running an HTTP server, hrserve launches a Chromium browser and intercepts its network requests: `GET` requests under the base URL are answered from a local directory, and every served file is watched. When a file changes, the running page is patched in place over the Chrome DevTools Protocol — no reload, no lost state.

## CLI Usage

```bash
npx hrserve [dir] --url http://localhost:3000/
```

Options:
- `--url`: Base URL of the page (default: `http://localhost:3000/`)
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
- `options.verbose`: Log request routing and CDP events (default: false)

#### `server.close()`

Stops watching files. Does not close the browser — the caller owns it.

#### `server.on(event, handler)`

Listen for server events.

**Events:**
- `'patch'`: Emitted once per file change. Handler receives `{ fileName, url, mimeType }`
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

Requests matching **no** rule go to the network, so a rule list without a `**` entry is an overlay rather than a full server.

### In-page events

When a watched JavaScript file changes, hrserve dispatches a `script-patch` `CustomEvent` on `window` so page code can react (e.g. re-run initialization):

```javascript
window.addEventListener("script-patch", (event) => {
  console.log("changed:", event.detail.scriptUrl);
});
```

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
