---
id: getting-started
title: Getting started
sidebar_label: Getting started
---

# Getting started

## Install

hrserve drives a real Chromium through Playwright, so the browser needs to be present once:

```bash
npx playwright install chromium
```

Then run it directly — no install step needed:

```bash
npx hrserve ./public --url http://localhost:3000/
```

Or add it to a project:

```bash
npm install --save-dev hrserve
```

## Command line

```bash
npx hrserve [dir] --url http://localhost:3000/
```

| Option | Description |
|---|---|
| `--url` | Base URL to serve at (default `http://localhost:3000/`) |
| `--mock-dir` | Directory of [mock API routes](./mock-api.md), run in-process |
| `--mock-path` | Path glob handled by `--mock-dir` / `--proxy` (default `/api/**`) |
| `--proxy` | Send `--mock-path` requests without a mock route to this origin |
| `--profile` | Start from a saved [profile](./profiles.md)'s cookies and storage |
| `--save-profile` | On Ctrl-C, save this session's cookies and storage under this name |
| `--devtools`, `-d` | Open devtools on start |
| `--verbose`, `-v` | Log request routing and CDP events |
| `--width`, `--height` | Browser window size |
| `--script-reload` | How to apply changed JavaScript: `auto` (default), `evaluate`, `import` or `off` |

Two extra commands:

```bash
npx hrserve profiles   # list saved profiles
npx hrserve mcp        # run the MCP server for agents
```

## Programmatic use

hrserve does not launch the browser for you when used as a library — you own it, which means you decide headless vs headed, and you can reuse one browser for many servers.

```javascript
import { chromium } from "playwright";
import { createServer } from "hrserve";

const browser = await chromium.launch({ headless: false });
const server = createServer(browser);

server.on("patch", ({ fileName, mimeType, applied, reason }) => {
  console.log(`${fileName} (${mimeType})`, applied ? "patched" : `not applied: ${reason}`);
});

const page = await server.serve({
  url: "http://localhost:3000/",
  dir: "./public",
});

// later
await server.close();      // stops watching; the browser is yours to close
await browser.close();
```

`serve()` resolves with the Playwright [`Page`](https://playwright.dev/docs/api/class-page) after the first navigation, so you can drive it however you like.

## What gets patched

| Type | Mechanism | Notes |
|---|---|---|
| `text/css` | `CSS.setStyleSheetText` | Validated first — invalid CSS is reported, not applied |
| `text/html` | `DOM.setOuterHTML` | Replaces the document; scroll and focus are not preserved |
| JavaScript | Re-run (classic scripts) or re-import (ES modules) | Preceded by a `script-patch` event so you can clean up first |
| Images | URL cache-busting in the live DOM/CSSOM | PNG, JPEG, GIF, SVG, WebP |

### Reacting to JavaScript changes

Chromium [removed live editing of JavaScript sources in Chrome 145](https://developer.chrome.com/blog/devtools-deprecates-live-editing), so a running script's body can no longer be swapped in place. hrserve **re-runs the new source** instead — indirect `eval` for classic scripts, `import()` of a cache-busted URL for ES modules — which means top-level side effects run again. The `script-patch` event fires *before* that happens, so your code can dispose of the old version:

```javascript
window.addEventListener("script-patch", (event) => {
  teardown();                                    // remove listeners, cancel timers, unmount
  event.detail.accept((exports) => render(exports.App));  // optional: use the re-run's result
  // event.preventDefault();                     // optional: handle the update yourself
});
```

See [JavaScript hot reload](https://github.com/sidorares/hrserve#javascript-hot-reload) for the full contract, the `scriptReload` option and the limitations of re-running.

The `patch` event tells you what actually happened, which matters when a change *looks* applied but wasn't:

```javascript
server.on("patch", ({ applied, reason }) => {
  // applied: false, reason: "css-invalid: ..." | "stylesheet-not-loaded"
  //                       | "hot-update-threw: ..." | "cancelled-by-page; ..."
});
```

## Development

```bash
npm ci
npx playwright install chromium   # needed once for browser tests
npm run build                     # tsc → dist/ (also the type check)
npm test                          # unit + browser tests
npm run lint                      # biome
npm run dev:ts                    # run the CLI from TypeScript sources
```
