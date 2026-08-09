---
id: api
title: API reference
sidebar_label: API reference
---

# API reference

## `createServer(browser, options?)`

Creates an hrserve instance around a Playwright [`Browser`](https://playwright.dev/docs/api/class-browser) you own.

| Option | Type | Description |
|---|---|---|
| `profilesDir` | `string` | Where [profiles](./profiles.md) are stored (default: the per-user data directory) |

## `server.serve(options)`

Starts serving and watching. Resolves with the Playwright `Page` after the first navigation.

| Option | Type | Description |
|---|---|---|
| `url` | `string` | Base URL to serve at |
| `dir` | `string` | Directory to serve from (optional when every rule sets its own `dir`) |
| `rules` | `Rule[]` | Ordered [routing rules](./routing.md); first match wins |
| `profile` | `string` | Saved [profile](./profiles.md) to start from |
| `scriptReload` | `"auto" \| "evaluate" \| "import" \| "off"` | How changed JavaScript is applied (default `"auto"`: re-run classic scripts, re-import ES modules) |
| `width` / `height` | `number` | Viewport size (default 1280×720) |
| `verbose` | `boolean` | Log request routing and CDP events |
| `onPage` | `(page) => unknown` | Called after interception is installed but **before** the first navigation — the only place to attach listeners that must not miss the initial load |

## `server.saveProfile(name)`

Snapshots the session's current cookies and storage as a named [profile](./profiles.md). Resolves with `{ name, parent, capturedAt, origins, cookieDomains }`. Never modifies the profile the session started from.

## `server.close()`

Stops watching files and closes mock routers. Does **not** close the browser — the caller owns it.

## Events

```javascript
server.on("patch", ({ fileName, url, mimeType, applied, reason }) => {});
server.on("request", ({ url, method, kind }) => {});
server.on("new-resource", ({ url, mimeType }) => {});
```

| Event | When | Notes |
|---|---|---|
| `patch` | Once per file change | `applied: false` means the change was seen but not put into the page; `reason` says why (`css-invalid`, `stylesheet-not-loaded`, `hot-update-threw`, `cancelled-by-page`, …) |
| `request` | Every intercepted request | `kind` is the routing decision: `file`, `fallback`, `mock`, `proxy` or `pass` |
| `new-resource` | A served file starts being watched | |

## Rule types

```typescript
type Rule =
  | { match?: string; methods?: string[]; action: "serve"; dir?: string }
  | { match?: string; methods?: string[]; action: "upstream" }
  | { match?: string; methods?: string[]; action: "proxy"; target: string }
  | { match?: string; methods?: string[]; action: "mock"; dir: string };
```

`match` defaults to `**` and is tested against the path relative to the base URL. See [Routing rules](./routing.md).

## `SessionManager`

```javascript
import { SessionManager } from "hrserve/dist/lib/session-manager.js";
const manager = new SessionManager({ browser, profilesDir });
```

| Method | Description |
|---|---|
| `start(options)` | Start a named session. Options: `name`, `dir`, `url`, `rules`, `profile`, `mockDir`, `mockPath`, `proxy`, `width`, `height` |
| `list()` | Summaries: name, url, dir, profile, patch count, error count |
| `get(name)` | The `Session` (throws with the running names if unknown) |
| `stop(name)` / `closeAll()` | Shut sessions down |

A `Session` exposes `page`, `context`, the `console` / `network` / `patches` buffers, `waitForPatch(timeoutMs)` and `saveProfile(name)`. See [Parallel sessions](./agents.md).

## `ProfileStore`

```javascript
import { ProfileStore, defaultProfilesDir, profileCoversUrl } from "hrserve";
```

| Member | Description |
|---|---|
| `new ProfileStore(dir?)` | Defaults to `defaultProfilesDir()` |
| `save(name, { storageState, parent })` | Writes a snapshot (mode `0600`, via temp file + rename) |
| `load(name)` / `list()` / `remove(name)` | Read and manage snapshots |
| `profileCoversUrl(profile, url)` | Whether a profile's origins or cookie domains apply to a URL |
