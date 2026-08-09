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
let upstream: http.Server;
let upstreamOrigin: string;

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-mockapi-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return dir;
}

before(async () => {
  browser = await chromium.launch({ headless: true });
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ from: "real-api", url: req.url }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("mock API routes end to end", () => {
  it("answers page fetches from in-process route files", async () => {
    const dir = await fixture({
      "index.html": "<!DOCTYPE html><html><body><h1>mock</h1></body></html>",
      "mocks/api/todos/route.ts": `
        const todos = [{ id: 1, title: "write tests" }];
        export function GET() {
          return Response.json(todos);
        }
        export async function POST(request: Request) {
          const body = await request.json();
          const todo = { id: todos.length + 1, title: body.title };
          todos.push(todo);
          return Response.json(todo, { status: 201 });
        }
      `,
      "mocks/api/todos/[id]/route.ts": `
        export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
          const { id } = await ctx.params;
          return Response.json({ id, title: "todo " + id });
        }
      `,
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({
        url: "http://mockapi.hrserve.test/",
        dir,
        rules: [
          { match: "/api/**", action: "mock", dir: path.join(dir, "mocks") },
          { match: "**", action: "serve" },
        ],
      });

      const list = await page.evaluate(() => fetch("/api/todos").then((r) => r.json()));
      assert.deepEqual(list, [{ id: 1, title: "write tests" }]);

      const created = await page.evaluate(() =>
        fetch("/api/todos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "ship it" }),
        }).then((r) => r.json())
      );
      assert.deepEqual(created, { id: 2, title: "ship it" });

      // Module-level state persists between requests, so the POST is visible
      const after = await page.evaluate(() => fetch("/api/todos").then((r) => r.json()));
      assert.equal(after.length, 2);

      const one = await page.evaluate(() => fetch("/api/todos/7").then((r) => r.json()));
      assert.deepEqual(one, { id: "7", title: "todo 7" });
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("falls through to the next rule when no mock route matches", async () => {
    const dir = await fixture({
      "index.html": "<!DOCTYPE html><html><body><h1>partial</h1></body></html>",
      "mocks/api/flags/route.ts": `
        export function GET() { return Response.json({ beta: true }); }
      `,
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({
        url: "http://fallthrough.hrserve.test/",
        dir,
        rules: [
          { match: "/api/**", action: "mock", dir: path.join(dir, "mocks") },
          { match: "/api/**", action: "proxy", target: upstreamOrigin },
          { match: "**", action: "serve" },
        ],
      });

      // Mocked endpoint answered locally
      const flags = await page.evaluate(() => fetch("/api/flags").then((r) => r.json()));
      assert.deepEqual(flags, { beta: true });

      // Everything else reaches the real API through the proxy
      const real = await page.evaluate(() => fetch("/api/users").then((r) => r.json()));
      assert.equal(real.from, "real-api");
      assert.equal(real.url, "/api/users");
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("picks up handler edits without restarting the browser", async () => {
    const dir = await fixture({
      "index.html": "<!DOCTYPE html><html><body><h1>hot</h1></body></html>",
      "mocks/api/config/route.ts": `
        export function GET() { return Response.json({ theme: "light" }); }
      `,
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({
        url: "http://hotmock.hrserve.test/",
        dir,
        rules: [
          { match: "/api/**", action: "mock", dir: path.join(dir, "mocks") },
          { match: "**", action: "serve" },
        ],
      });

      const before = await page.evaluate(() => fetch("/api/config").then((r) => r.json()));
      assert.deepEqual(before, { theme: "light" });

      await fs.writeFile(
        path.join(dir, "mocks", "api", "config", "route.ts"),
        'export function GET() { return Response.json({ theme: "dark" }); }\n'
      );

      const deadline = Date.now() + 10_000;
      let theme = "";
      while (theme !== "dark" && Date.now() < deadline) {
        const payload = await page.evaluate(() => fetch("/api/config").then((r) => r.json()));
        theme = payload.theme;
        if (theme !== "dark") await new Promise((resolve) => setTimeout(resolve, 150));
      }
      assert.equal(theme, "dark", "edited mock handler should be picked up");
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("serves a Next-style app directory directly, ignoring its UI files", async () => {
    const dir = await fixture({
      "index.html": "<!DOCTYPE html><html><body><h1>next</h1></body></html>",
      // Pointing straight at a real Next app/ directory should just work
      "app/page.tsx": "export default function Page() { return null; }",
      "app/layout.tsx": "export default function Layout() { return null; }",
      "app/api/health/route.ts": "export function GET() { return Response.json({ ok: true }); }",
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({
        url: "http://nextapp.hrserve.test/",
        dir,
        rules: [
          { match: "/api/**", action: "mock", dir: path.join(dir, "app") },
          { match: "**", action: "serve" },
        ],
      });

      const health = await page.evaluate(() => fetch("/api/health").then((r) => r.json()));
      assert.deepEqual(health, { ok: true });
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 500 without crashing when a handler throws", async () => {
    const dir = await fixture({
      "index.html": "<!DOCTYPE html><html><body><h1>boom</h1></body></html>",
      "mocks/api/boom/route.ts": `export function GET() { throw new Error("kaboom"); }`,
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({
        url: "http://boom.hrserve.test/",
        dir,
        rules: [
          { match: "/api/**", action: "mock", dir: path.join(dir, "mocks") },
          { match: "**", action: "serve" },
        ],
      });

      const status = await page.evaluate(() => fetch("/api/boom").then((r) => r.status));
      assert.equal(status, 500);
      // The page is still alive and serving
      assert.equal(await page.textContent("h1"), "boom");
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
