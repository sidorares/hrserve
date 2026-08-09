import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium } from "playwright";
import { SessionManager } from "../../lib/session-manager";

let browser: Browser;
let manager: SessionManager;
const fixtures: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-session-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  fixtures.push(dir);
  return dir;
}

const page = (body: string) => `<!DOCTYPE html><html><body>${body}</body></html>`;

before(async () => {
  browser = await chromium.launch({ headless: true });
  manager = new SessionManager({ browser });
});

after(async () => {
  await manager.closeAll();
  await browser.close();
  await Promise.all(fixtures.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SessionManager", () => {
  it("serves two worktrees at the same URL at once", async () => {
    // The point of the whole design: no ports, so no port juggling between
    // parallel sessions — both worktrees live at the identical origin.
    const worktreeA = await fixture({ "index.html": page("<h1>branch-a</h1>") });
    const worktreeB = await fixture({ "index.html": page("<h1>branch-b</h1>") });

    const a = await manager.start({ name: "a", dir: worktreeA });
    const b = await manager.start({ name: "b", dir: worktreeB });

    assert.equal(a.url, b.url, "both sessions should use the same URL");
    assert.equal(await manager.get("a").page.textContent("h1"), "branch-a");
    assert.equal(await manager.get("b").page.textContent("h1"), "branch-b");

    assert.deepEqual(
      manager.list().map((session) => session.name),
      ["a", "b"]
    );

    await manager.stop("a");
    assert.deepEqual(
      manager.list().map((session) => session.name),
      ["b"]
    );
    assert.throws(() => manager.get("a"), /No session named "a"/);
    await manager.stop("b");
  });

  it("rejects a duplicate session name", async () => {
    const dir = await fixture({ "index.html": page("<h1>dup</h1>") });
    await manager.start({ name: "dup", dir });
    await assert.rejects(() => manager.start({ name: "dup", dir }), /already running/);
    await manager.stop("dup");
  });

  it("records console messages and uncaught errors separately from other sessions", async () => {
    const dir = await fixture({
      "index.html": page('<h1>logs</h1><script src="app.js"></script>'),
      "app.js":
        'console.log("hello from page");\nsetTimeout(() => { throw new Error("boom"); }, 0);\n',
    });
    const quiet = await fixture({ "index.html": page("<h1>quiet</h1>") });

    await manager.start({ name: "noisy", dir });
    await manager.start({ name: "quiet", dir: quiet });
    const session = manager.get("noisy");

    const deadline = Date.now() + 10_000;
    while (session.console.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.ok(
      session.console.some((entry) => entry.text.includes("hello from page")),
      "console.log should be captured"
    );
    assert.ok(
      session.console.some((entry) => entry.type === "error" && entry.text.includes("boom")),
      "uncaught exceptions should be captured as errors"
    );
    assert.equal(session.info.errors, 1);
    assert.equal(manager.get("quiet").console.length, 0, "sessions must not share buffers");

    await manager.stop("noisy");
    await manager.stop("quiet");
  });

  it("annotates the request log with how each request was answered", async () => {
    const dir = await fixture({
      "index.html": page("<h1>net</h1>"),
      "mocks/api/ping/route.ts": "export function GET() { return Response.json({ ok: true }); }",
    });

    await manager.start({ name: "net", dir, mockDir: path.join(dir, "mocks") });
    const session = manager.get("net");
    await session.page.evaluate(() => fetch("/api/ping").then((r) => r.json()));

    const sources = new Map(
      session.network.map((entry) => [new URL(entry.url).pathname, entry.source])
    );
    assert.equal(sources.get("/"), "served-local");
    assert.equal(sources.get("/api/ping"), "mocked");

    await manager.stop("net");
  });

  it("records patch outcomes, including why a patch was not applied", async () => {
    const dir = await fixture({
      "index.html": page('<link rel="stylesheet" href="style.css"><h1>patch</h1>'),
      "style.css": "h1 { color: rgb(255, 0, 0); }",
    });

    await manager.start({ name: "patches", dir });
    const session = manager.get("patches");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const applied = session.waitForPatch();
    await fs.writeFile(path.join(dir, "style.css"), "h1 { color: rgb(0, 128, 0); }");
    const good = await applied;
    assert.equal(good.applied, true);
    assert.equal(good.mimeType, "text/css");

    // Belt and braces, like betweenWrites() in integration.test.ts: back-to-back
    // writes are handled by awaitWriteFinish (lib/watch-options.ts), and the
    // delay only keeps this test — which is about patch history, not watching —
    // insensitive to the configured threshold.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Invalid CSS is detected but deliberately not applied — the history says so
    const rejected = session.waitForPatch();
    await fs.writeFile(path.join(dir, "style.css"), "h1 { color: }");
    const bad = await rejected;
    assert.equal(bad.applied, false);
    assert.match(bad.reason ?? "", /css-invalid/);

    // ...and the page still shows the last good value
    const color = await session.page.evaluate(
      () => getComputedStyle(document.querySelector("h1") as Element).color
    );
    assert.equal(color, "rgb(0, 128, 0)");

    await manager.stop("patches");
  });
});
