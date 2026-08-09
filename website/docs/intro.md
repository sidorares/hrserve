---
id: intro
title: Introduction
sidebar_label: Introduction
slug: /
---

# hrserve

A development server that patches file changes into a running page without reloading it — and, because of how it works, without ever opening a port.

```bash
npx hrserve ./public --url http://localhost:3000/
```

## The browser is the server

Most dev servers listen on a socket and hope nothing else wants that number. hrserve doesn't listen at all. It launches Chromium through [Playwright](https://playwright.dev/) and intercepts the browser's own network requests:

1. A `GET` under the base URL is answered from your local directory.
2. Anything else goes to the real network, untouched.
3. Every file it serves is watched. When one changes, the running page is **patched in place** over the Chrome DevTools Protocol — no reload, no lost state.

Three useful properties fall out of that design, and most of hrserve's features are consequences of them:

| Property | What it enables |
|---|---|
| **No ports** | An origin like `http://app.test/` exists only inside one browser context. It needs no socket, no `/etc/hosts` entry, and never collides — so [many sessions can serve the same URL at once](./agents.md). |
| **Overlay any origin** | Local files can be served *at a production URL* while everything else still hits the real site. |
| **CDP access to the live page** | hrserve can patch, inspect and screenshot the running page, which is what makes the [MCP server](./mcp-integration.md) useful to coding agents. |

## What it can patch

| Type | How |
|---|---|
| **CSS** | Applied via `CSS.setStyleSheetText` — no reload. Invalid CSS is rejected rather than applied. |
| **HTML** | Full DOM replacement via `DOM.setOuterHTML`. |
| **JavaScript** | The new source is re-run — indirect `eval` for classic scripts, `import()` of a cache-busted URL for ES modules — after a `script-patch` event that lets your code dispose of the old version. (Chromium [removed LiveEdit in Chrome 145](https://developer.chrome.com/blog/devtools-deprecates-live-editing), so in-place source swapping is gone — see [Supported file types](./getting-started.md#what-gets-patched).) |
| **Images** | Cache-busted everywhere they appear: `<img>`, `srcset`, `<picture>`, CSS backgrounds, inline styles, SVG `<image>`, favicons. |

## Beyond hot reload

- **[Routing rules](./routing.md)** — mix local files, a real backend and a proxied one in a single page, first-match-wins.
- **[Mock API routes](./mock-api.md)** — file-based API mocks following Next.js conventions, executed in-process. No port, no spawned server.
- **[Session profiles](./profiles.md)** — sign in or clear a captcha once, then start later sessions already authenticated.
- **[Parallel sessions and MCP](./agents.md)** — run many worktrees at the same URL simultaneously, and let a coding agent drive and verify them.

## Where to go next

Start with [Getting started](./getting-started.md), or jump to [MCP setup](./mcp-integration.md) if you want to wire hrserve into Claude Code, Cursor or VS Code right away.
