---
id: agents
title: Parallel sessions and agents
sidebar_label: Parallel sessions
---

# Parallel sessions and agents

Running several coding agents at once is a solved problem for *code* — git worktrees — and an unsolved one for *preview servers*. Every conventional dev server wants a port, so N worktrees mean N ports to allocate, track and clean up, and N different URLs, which breaks anything that cares about its own origin.

hrserve doesn't have that problem. An origin is a **name inside a browser context, not a socket**, so every worktree can be served at the *same* URL simultaneously, each in its own isolated context.

```javascript
import { SessionManager } from "hrserve/dist/lib/session-manager.js";

const manager = new SessionManager({ browser });

await manager.start({ name: "feature-a", dir: "~/wt/feature-a" });
await manager.start({ name: "feature-b", dir: "~/wt/feature-b" }); // same URL, no conflict

manager.list();          // names, dirs, patch counts, error counts
manager.get("feature-a").page;   // the Playwright Page
await manager.stop("feature-a");
```

Each session buffers its own console output, request log and patch history, so they never mix.

## What each session records

| Buffer | Contents |
|---|---|
| `session.console` | Console messages **and uncaught exceptions**, captured from the first load onwards |
| `session.network` | Every request with how it was answered: `served-local`, `mocked`, `proxied`, `upstream` or `blocked` |
| `session.patches` | Each patch with `applied` and, when false, the `reason` |

`session.waitForPatch()` resolves when the next patch lands, so you can await "my edit reached the page" instead of polling.

Sessions also accept a [`profile`](./profiles.md), so they can start already signed in:

```javascript
await manager.start({ name: "feature-a", dir: "~/wt/a", profile: "login" });
await manager.get("feature-a").saveProfile("login-plus-cart");
```

## The MCP server

An agent that edits a file has no way to *verify* the result — it can't see the page, and standing up browser tooling per worktree is heavy. hrserve already holds exactly the handles it needs, and exposes them over the [Model Context Protocol](https://modelcontextprotocol.io/):

```bash
npx hrserve mcp            # stdio MCP server
npx hrserve mcp --headed   # ...with a visible browser window to watch
```

See **[MCP setup](./mcp-integration.md)** for wiring this into Claude Code, Claude Desktop, Cursor, VS Code and other clients.

### Tools

| Tool | Answers |
|---|---|
| `serve_start` / `serve_list` / `serve_stop` | Session lifecycle, one per worktree. `serve_start` takes a `profile` to begin signed in |
| `page_screenshot` | "What does it look like now?" — PNG, optionally full-page or a single element |
| `page_console` | "Did my change break anything?" — console plus uncaught errors, filterable to errors only |
| `page_network` | "Why did that request return that?" — each entry labelled with how it was answered |
| `patch_history` | "Did my edit reach the page?" — with `applied` and the reason when it didn't |
| `wait_for_patch` | Blocks until the next patch lands, instead of polling |
| `page_dom` | Text or HTML snapshot for non-visual assertions |
| `page_eval` | Runs an expression in the page |
| `page_reload` | Full reload, discarding patched state |
| `set_viewport` | Resize, e.g. to check a responsive layout |
| `profile_list` / `profile_save` | Reuse a sign-in across sessions |

### A typical agent loop

1. `serve_start` with the worktree directory (and a `profile`, if the app needs a login).
2. Edit files as usual.
3. `wait_for_patch` — the edit has now reached the page.
4. `page_console` with `onlyErrors: true` — did it break anything?
5. `page_screenshot` or `page_dom` — does it look right?

:::danger Trust model
`page_eval` runs arbitrary JavaScript in the page, and mock handlers are ordinary modules executed in this process. **An MCP client connected to this server can run code on your machine.** Only connect clients you would already trust with a shell.
:::
