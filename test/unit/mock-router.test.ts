import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { MockRouter } from "../../lib/mock-router";

const BASE = "http://mock.test";

async function writeFixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-mock-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return dir;
}

describe("MockRouter", () => {
  let dir: string;
  let router: MockRouter;

  before(async () => {
    dir = await writeFixture({
      "api/users/route.ts": `
        export async function GET() {
          return Response.json([{ id: 1, name: "Ada" }]);
        }
        export async function POST(request: Request) {
          const body = await request.json();
          return Response.json({ created: body.name }, { status: 201 });
        }
      `,
      "api/users/[id]/route.ts": `
        export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
          const { id } = await ctx.params;
          return Response.json({ id });
        }
      `,
      "api/sync-params/[id]/route.js": `
        export function GET(request, ctx) {
          // Next 14 style: params read directly, without awaiting
          return Response.json({ id: ctx.params.id });
        }
      `,
      "api/counter/route.ts": `
        let count = 0;
        export function GET() {
          count += 1;
          return Response.json({ count });
        }
      `,
      "api/echo/route.ts": `
        export async function PUT(request: Request) {
          return new Response(await request.text(), {
            status: 200,
            headers: { "content-type": "text/plain", "x-custom": "yes" },
          });
        }
      `,
      "api/legacy.ts": `
        export default function handler(req, res) {
          res.status(200).json({ method: req.method, query: req.query, body: req.body });
        }
      `,
      "api/legacy/[id].ts": `
        export default function handler(req, res) {
          res.setHeader("x-from", "pages");
          res.status(202).send("id=" + req.query.id);
        }
      `,
      "api/broken/route.ts": `
        export function GET() {
          throw new Error("handler blew up");
        }
      `,
    });
    router = new MockRouter({ dir });
    await router.start();
  });

  after(async () => {
    await router.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Mirrors serve(): routes are matched on the path, handlers get the full URL. */
  async function call(
    target: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {}
  ) {
    const url = new URL(BASE + target);
    const match = router.match(url.pathname);
    assert.ok(match, `no mock route matched ${url.pathname}`);
    const response = await router.handle(match, {
      url: url.toString(),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body ? Buffer.from(init.body) : undefined,
    });
    return { ...response, text: response.body.toString() };
  }

  it("runs an app-router GET handler", async () => {
    const response = await call("/api/users");
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), [{ id: 1, name: "Ada" }]);
    assert.match(response.headers["content-type"], /application\/json/);
  });

  it("passes the request body to a POST handler and keeps its status", async () => {
    const response = await call("/api/users", {
      method: "POST",
      body: JSON.stringify({ name: "Grace" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 201);
    assert.deepEqual(JSON.parse(response.text), { created: "Grace" });
  });

  it("supplies params as an awaitable (Next 15 style)", async () => {
    const response = await call("/api/users/99");
    assert.deepEqual(JSON.parse(response.text), { id: "99" });
  });

  it("supplies params as a plain object too (Next 14 style)", async () => {
    const response = await call("/api/sync-params/7");
    assert.deepEqual(JSON.parse(response.text), { id: "7" });
  });

  it("preserves module state between requests", async () => {
    const first = await call("/api/counter");
    const second = await call("/api/counter");
    assert.equal(JSON.parse(first.text).count, 1);
    assert.equal(JSON.parse(second.text).count, 2);
  });

  it("passes through custom headers and non-JSON bodies", async () => {
    const response = await call("/api/echo", { method: "PUT", body: "ping" });
    assert.equal(response.text, "ping");
    assert.equal(response.headers["x-custom"], "yes");
  });

  it("answers 405 with an Allow header for an unexported method", async () => {
    const response = await call("/api/users", { method: "DELETE" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, "GET, POST");
  });

  it("serves HEAD from GET with an empty body", async () => {
    const response = await call("/api/users", { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 0);
  });

  it("answers OPTIONS with the exported methods", async () => {
    const response = await call("/api/users", { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(response.headers.allow, "GET, POST, OPTIONS");
  });

  it("runs pages-router handlers with req/res shims", async () => {
    const response = await call("/api/legacy?limit=5", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), {
      method: "POST",
      query: { limit: "5" },
      body: { hello: "world" },
    });
  });

  it("supports res.setHeader/status/send and route params in pages handlers", async () => {
    const response = await call("/api/legacy/13");
    assert.equal(response.status, 202);
    assert.equal(response.headers["x-from"], "pages");
    assert.equal(response.text, "id=13");
  });

  it("lets handler errors surface to the caller", async () => {
    const match = router.match("/api/broken");
    assert.ok(match);
    await assert.rejects(
      () => router.handle(match, { url: `${BASE}/api/broken`, method: "GET", headers: {} }),
      /handler blew up/
    );
  });

  it("does not match paths without a route file", () => {
    assert.equal(router.match("/api/nothing-here"), undefined);
  });

  it("picks up edits to a handler without a restart", async () => {
    const file = path.join(dir, "api", "users", "route.ts");
    const original = await fs.readFile(file, "utf-8");
    try {
      await fs.writeFile(
        file,
        "export function GET() { return Response.json({ edited: true }); }\n"
      );
      // wait for the watcher to drop the module cache
      const deadline = Date.now() + 10_000;
      let payload: Record<string, unknown> = {};
      while (Date.now() < deadline) {
        payload = JSON.parse((await call("/api/users")).text);
        if (payload.edited) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(payload.edited, true);
    } finally {
      await fs.writeFile(file, original);
    }
  });

  it("picks up a newly added route file", async () => {
    const file = path.join(dir, "api", "added", "route.ts");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "export function GET() { return Response.json({ new: true }); }\n");
    const deadline = Date.now() + 10_000;
    while (!router.match("/api/added") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(router.match("/api/added"), "new route should be picked up by the watcher");
  });
});
