---
id: mcp-integration
title: MCP setup
sidebar_label: MCP setup
---

# Connecting hrserve to your tools

`hrserve mcp` runs an [MCP](https://modelcontextprotocol.io/) server over stdio, giving a coding agent the ability to serve a worktree and then **verify its own edits** — screenshot the page, read the console, check how a request was answered. See [Parallel sessions and agents](./agents.md) for what the tools do.

Every client below launches the same command:

```bash
npx -y hrserve mcp
```

If hrserve is already a dependency of the project, `npx hrserve mcp` (without `-y`) uses the local copy. Chromium must be installed once: `npx playwright install chromium`.

:::danger Read this before connecting anything
`page_eval` runs arbitrary JavaScript in the page and mock handlers are ordinary modules executed in this process, so **a client connected to this server can run code on your machine**. Only connect clients you'd already trust with a shell, and prefer project-scoped configuration you can review in the repo.
:::

## Claude Code

Add it with the CLI:

```bash
claude mcp add hrserve -- npx -y hrserve mcp
```

By default this is scoped to you on this project. Use `--scope project` to write a `.mcp.json` that the whole team shares, or `--scope user` to make it available in every project:

```bash
claude mcp add --scope project hrserve -- npx -y hrserve mcp
```

The `--` separator matters: everything after it is the server's own command and arguments.

Project-scoped config lands in `.mcp.json` at the repository root, which you can also write by hand:

```json
{
  "mcpServers": {
    "hrserve": {
      "command": "npx",
      "args": ["-y", "hrserve", "mcp"]
    }
  }
}
```

Check it connected with `/mcp` inside Claude Code, or `claude mcp list`.

## Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "hrserve": {
      "command": "npx",
      "args": ["-y", "hrserve", "mcp"]
    }
  }
}
```

Restart Claude Desktop afterwards. Because the desktop app has no project directory, pass **absolute paths** to `serve_start` (`/Users/you/code/app`, not `./app`).

## Cursor

Create `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "hrserve": {
      "command": "npx",
      "args": ["-y", "hrserve", "mcp"]
    }
  }
}
```

The server appears under **Settings → MCP**, where you can confirm the tools were discovered.

## VS Code (GitHub Copilot)

VS Code uses a different top-level key — **`servers`**, not `mcpServers`. Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "hrserve": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "hrserve", "mcp"]
    }
  }
}
```

`"type": "stdio"` is optional (it's the default for local servers) but explicit is clearer. Open Copilot Chat in **Agent mode** to use the tools.

## Other clients

Most MCP clients — Windsurf, Zed, JetBrains AI Assistant, Continue and others — use the same `mcpServers` shape as Claude Desktop, differing only in where the file lives. Check your client's docs for the path, then use:

```json
{
  "mcpServers": {
    "hrserve": {
      "command": "npx",
      "args": ["-y", "hrserve", "mcp"]
    }
  }
}
```

To watch the browser while the agent drives it, add the flag:

```json
{ "command": "npx", "args": ["-y", "hrserve", "mcp", "--headed"] }
```

## Verifying it works

Ask the agent to run through a round trip:

> Start an hrserve session called `demo` serving `./public`, then screenshot it.

You should see `serve_start` followed by `page_screenshot` returning an image. Then try the loop that makes hrserve useful:

> Change the `h1` colour in `public/style.css` to red, wait for the patch, and confirm there are no console errors.

That exercises `wait_for_patch`, `patch_history` and `page_console` — the three tools that answer "did my edit land, and did it break anything".

## Troubleshooting

**The server doesn't appear, or the client reports a connection error.** Run `npx -y hrserve mcp` in a terminal: it should print `hrserve MCP server ready` to stderr and then wait. If it exits, the error text is the real cause.

**`browserType.launch: Executable doesn't exist`.** Chromium isn't installed for this Playwright version — run `npx playwright install chromium`.

**Tools work but every `serve_start` fails on the path.** Use an absolute directory. Clients differ in what working directory they spawn the server with, and Claude Desktop in particular has no project context at all.

**Sessions vanish between requests.** Each MCP client process gets its own server and therefore its own sessions; restarting the client stops the browser and drops every session.

**Protocol errors or garbled JSON.** Something wrote to stdout, which is the protocol stream. hrserve redirects its own logging to stderr, but a `console.log` inside one of *your* [mock handlers](./mock-api.md) is executed in this process — move it to `console.error`.
