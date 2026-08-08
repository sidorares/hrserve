import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type Browser, chromium } from "playwright";
import { createMcpServer } from "../../lib/mcp-server";
import { SessionManager } from "../../lib/session-manager";

let browser: Browser;
let manager: SessionManager;
let client: Client;
const fixtures: string[] = [];

interface TextContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-mcp-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  fixtures.push(dir);
  return dir;
}

/** Call a tool the way a real MCP client would, over a linked transport pair. */
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: TextContent[];
  };
  return result;
}

function textOf(result: { content: TextContent[] }): string {
  return result.content.map((entry) => entry.text ?? "").join("\n");
}

function jsonOf(result: { content: TextContent[] }): unknown {
  return JSON.parse(textOf(result));
}

before(async () => {
  browser = await chromium.launch({ headless: true });
  manager = new SessionManager({ browser });
  const server = createMcpServer(manager);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-agent", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
  await manager.closeAll();
  await browser.close();
  await Promise.all(fixtures.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("MCP server", () => {
  it("advertises the agent-facing tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "page_console",
      "page_dom",
      "page_eval",
      "page_network",
      "page_reload",
      "page_screenshot",
      "patch_history",
      "profile_list",
      "profile_save",
      "serve_list",
      "serve_start",
      "serve_stop",
      "set_viewport",
      "wait_for_patch",
    ]);
  });

  it("starts, lists and stops sessions", async () => {
    const dir = await fixture({
      "index.html": "<!DOCTYPE html><html><body><h1>agent</h1></body></html>",
    });

    const started = jsonOf(await callTool("serve_start", { name: "wt1", dir })) as {
      name: string;
      url: string;
    };
    assert.equal(started.name, "wt1");

    const list = jsonOf(await callTool("serve_list")) as Array<{ name: string }>;
    assert.deepEqual(
      list.map((session) => session.name),
      ["wt1"]
    );

    assert.match(textOf(await callTool("serve_stop", { name: "wt1" })), /Stopped session "wt1"/);
    assert.deepEqual(jsonOf(await callTool("serve_list")), []);
  });

  it("reports a helpful error instead of throwing for an unknown session", async () => {
    const result = await callTool("page_dom", { name: "does-not-exist" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No session named "does-not-exist"/);
  });

  it("reads page text and evaluates expressions", async () => {
    const dir = await fixture({
      "index.html":
        '<!DOCTYPE html><html><body><h1>hello agent</h1><div id="x">42</div></body></html>',
    });
    await callTool("serve_start", { name: "read", dir });

    assert.match(textOf(await callTool("page_dom", { name: "read" })), /hello agent/);
    assert.match(textOf(await callTool("page_dom", { name: "read", selector: "#x" })), /42/);
    assert.equal(
      textOf(await callTool("page_eval", { name: "read", expression: "document.title || 'none'" })),
      "none"
    );
    assert.equal(jsonOf(await callTool("page_eval", { name: "read", expression: "1 + 1" })), 2);

    await callTool("serve_stop", { name: "read" });
  });

  it("returns a PNG screenshot", async () => {
    const dir = await fixture({
      "index.html": "<!DOCTYPE html><html><body><h1>shot</h1></body></html>",
    });
    await callTool("serve_start", { name: "shot", dir });

    const result = await callTool("page_screenshot", { name: "shot" });
    const image = result.content[0];
    assert.equal(image.type, "image");
    assert.equal(image.mimeType, "image/png");
    const bytes = Buffer.from(image.data as string, "base64");
    assert.ok(bytes.length > 0);
    // PNG magic number, i.e. this really is an image
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    await callTool("serve_stop", { name: "shot" });
  });

  it("surfaces console errors so an agent can tell a change broke the page", async () => {
    const dir = await fixture({
      "index.html": '<!DOCTYPE html><html><body><script src="bad.js"></script></body></html>',
      "bad.js": 'console.warn("careful");\nundefinedFunction();\n',
    });
    await callTool("serve_start", { name: "errs", dir });

    const deadline = Date.now() + 10_000;
    let errors: Array<{ text: string }> = [];
    while (!errors.length && Date.now() < deadline) {
      errors = jsonOf(await callTool("page_console", { name: "errs", onlyErrors: true })) as Array<{
        text: string;
      }>;
      if (!errors.length) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.ok(
      errors.some((entry) => entry.text.includes("undefinedFunction")),
      "the uncaught ReferenceError should be reported"
    );

    // Without onlyErrors the warning is there too
    const all = jsonOf(await callTool("page_console", { name: "errs" })) as Array<{ text: string }>;
    assert.ok(all.some((entry) => entry.text.includes("careful")));

    await callTool("serve_stop", { name: "errs" });
  });

  it("explains how each request was answered", async () => {
    const dir = await fixture({
      "index.html": "<!DOCTYPE html><html><body><h1>net</h1></body></html>",
      "mocks/api/ping/route.ts": "export function GET() { return Response.json({ ok: true }); }",
    });
    await callTool("serve_start", { name: "net", dir, mockDir: path.join(dir, "mocks") });
    await callTool("page_eval", { name: "net", expression: "fetch('/api/ping')" });

    const deadline = Date.now() + 10_000;
    let mocked: Array<{ url: string }> = [];
    while (!mocked.length && Date.now() < deadline) {
      mocked = jsonOf(await callTool("page_network", { name: "net", source: "mocked" })) as Array<{
        url: string;
      }>;
      if (!mocked.length) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(mocked.length, 1);
    assert.match(mocked[0].url, /\/api\/ping$/);

    const local = jsonOf(
      await callTool("page_network", { name: "net", source: "served-local" })
    ) as Array<{ url: string }>;
    assert.ok(local.length >= 1);

    await callTool("serve_stop", { name: "net" });
  });

  it("waits for a patch and reports whether it was applied", async () => {
    const dir = await fixture({
      "index.html":
        '<!DOCTYPE html><html><body><link rel="stylesheet" href="style.css"><h1>p</h1></body></html>',
      "style.css": "h1 { color: rgb(255, 0, 0); }",
    });
    await callTool("serve_start", { name: "patch", dir });
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The agent asks to be woken when its edit lands, rather than polling
    const waiting = callTool("wait_for_patch", { name: "patch", timeoutMs: 10_000 });
    await fs.writeFile(path.join(dir, "style.css"), "h1 { color: rgb(0, 128, 0); }");
    const patch = jsonOf(await waiting) as { applied: boolean; mimeType: string };
    assert.equal(patch.applied, true);
    assert.equal(patch.mimeType, "text/css");

    const history = jsonOf(await callTool("patch_history", { name: "patch" })) as unknown[];
    assert.equal(history.length, 1);

    await callTool("serve_stop", { name: "patch" });
  });

  it("resizes the viewport", async () => {
    const dir = await fixture({
      "index.html": "<!DOCTYPE html><html><body><h1>size</h1></body></html>",
    });
    await callTool("serve_start", { name: "size", dir });

    await callTool("set_viewport", { name: "size", width: 400, height: 700 });
    assert.equal(
      jsonOf(await callTool("page_eval", { name: "size", expression: "window.innerWidth" })),
      400
    );

    await callTool("serve_stop", { name: "size" });
  });
});
