import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type Browser, type Page, chromium } from "playwright";
import { createServer } from "../../lib/hrserve";

let browser: Browser;
/** A real HTTP server standing in for "the network" (upstream / proxy target). */
let upstream: http.Server;
let upstreamOrigin: string;
const upstreamHits: Array<{ method: string; url: string; body: string }> = [];

async function makeFixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-routing-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return dir;
}

before(async () => {
  browser = await chromium.launch({ headless: true });

  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      upstreamHits.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from: "upstream", method: req.method, url: req.url, body }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("routing rules", () => {
  it("serves matched paths locally and lets unmatched ones reach the network", async () => {
    upstreamHits.length = 0;
    const dir = await makeFixture({
      "index.html": "<!DOCTYPE html><html><body><h1>local</h1></body></html>",
      "app.css": "h1 { color: rgb(1, 2, 3); }",
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      // Base URL *is* the real server, so "upstream" requests are really served by it
      page = await server.serve({
        url: `${upstreamOrigin}/`,
        dir,
        rules: [
          { match: "/api/**", action: "upstream" },
          { match: "**", action: "serve" },
        ],
      });

      // index.html came from disk, not from the upstream server
      assert.equal(await page.textContent("h1"), "local");

      const api = await page.evaluate(() => fetch("/api/ping").then((r) => r.json()));
      assert.equal(api.from, "upstream");
      assert.deepEqual(
        upstreamHits.map((hit) => hit.url),
        ["/api/ping"],
        "only the /api request should have reached the network"
      );
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("proxies matched paths to another origin without CORS", async () => {
    upstreamHits.length = 0;
    const dir = await makeFixture({
      "index.html": "<!DOCTYPE html><html><body><h1>proxy</h1></body></html>",
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({
        url: "http://proxy.hrserve.test/",
        dir,
        rules: [
          { match: "/api/**", action: "proxy", target: upstreamOrigin },
          { match: "**", action: "serve" },
        ],
      });

      // The page reads the body of a cross-origin response: only possible because
      // the browser still considers this a same-origin request.
      const json = await page.evaluate(() => fetch("/api/users?q=1").then((r) => r.json()));
      assert.equal(json.from, "upstream");
      assert.equal(json.url, "/api/users?q=1", "path and query survive the rewrite");
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("proxies non-GET requests with their body intact", async () => {
    upstreamHits.length = 0;
    const dir = await makeFixture({
      "index.html": "<!DOCTYPE html><html><body><h1>post</h1></body></html>",
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({
        url: "http://post.hrserve.test/",
        dir,
        rules: [
          { match: "/api/**", action: "proxy", target: upstreamOrigin },
          { match: "**", action: "serve" },
        ],
      });

      const json = await page.evaluate(() =>
        fetch("/api/todos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "write tests" }),
        }).then((r) => r.json())
      );
      assert.equal(json.method, "POST");
      assert.deepEqual(JSON.parse(json.body), { title: "write tests" });
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("serves several directories at different mount points", async () => {
    const site = await makeFixture({
      "index.html": "<!DOCTYPE html><html><body><h1>site</h1></body></html>",
    });
    const ui = await makeFixture({ "ui/button.css": ".btn { color: rgb(4, 5, 6); }" });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({
        url: "http://mounts.hrserve.test/",
        dir: site,
        rules: [
          { match: "/ui/**", action: "serve", dir: ui },
          { match: "**", action: "serve" },
        ],
      });

      assert.equal(await page.textContent("h1"), "site");
      const css = await page.evaluate(() => fetch("/ui/button.css").then((r) => r.text()));
      assert.match(css, /rgb\(4, 5, 6\)/);
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(site, { recursive: true, force: true });
      await fs.rm(ui, { recursive: true, force: true });
    }
  });

  it("still patches files served through a scoped rule", async () => {
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="/static/style.css"></head>' +
        "<body><h1>scoped</h1></body></html>",
      "static/style.css": "h1 { color: rgb(255, 0, 0); }",
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({
        url: "http://scoped.hrserve.test/",
        dir,
        rules: [
          { match: "/static/**", action: "serve" },
          { match: "**", action: "serve" },
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      const patched = new Promise((resolve) => server.on("patch", resolve));
      await fs.writeFile(path.join(dir, "static", "style.css"), "h1 { color: rgb(0, 128, 0); }");
      await patched;

      const deadline = Date.now() + 10_000;
      let color = "";
      while (color !== "rgb(0, 128, 0)" && Date.now() < deadline) {
        color = await page.evaluate(
          () => getComputedStyle(document.querySelector("h1") as Element).color
        );
        if (color !== "rgb(0, 128, 0)") await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(color, "rgb(0, 128, 0)");
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
