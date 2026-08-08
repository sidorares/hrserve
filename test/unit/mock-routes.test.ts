import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type MockRoute, matchRoute, parseSegment, scanRoutes } from "../../lib/mock-routes";

async function fixture(files: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-routes-"));
  for (const file of files) {
    const full = path.join(dir, file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, "export function GET() {}\n");
  }
  return dir;
}

const patterns = (routes: MockRoute[]) => routes.map((route) => route.pattern);

describe("parseSegment", () => {
  it("recognises every Next segment form", () => {
    assert.deepEqual(parseSegment("users"), { kind: "static", value: "users" });
    assert.deepEqual(parseSegment("[id]"), { kind: "dynamic", name: "id" });
    assert.deepEqual(parseSegment("[...slug]"), { kind: "catchAll", name: "slug" });
    assert.deepEqual(parseSegment("[[...slug]]"), { kind: "optionalCatchAll", name: "slug" });
  });
});

describe("scanRoutes", () => {
  it("maps app-router route files to their directory", async () => {
    const dir = await fixture(["api/users/route.ts", "api/users/[id]/route.ts", "api/route.js"]);
    try {
      assert.deepEqual(patterns(await scanRoutes(dir)).sort(), [
        "/api",
        "/api/users",
        "/api/users/[id]",
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("maps pages-router files to their path, with index meaning the directory", async () => {
    const dir = await fixture(["api/users.ts", "api/posts/index.ts", "api/posts/[id].ts"]);
    try {
      assert.deepEqual(patterns(await scanRoutes(dir)).sort(), [
        "/api/posts",
        "/api/posts/[id]",
        "/api/users",
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores app-router UI files, private files and declarations", async () => {
    const dir = await fixture([
      "api/users/route.ts",
      "page.tsx",
      "layout.tsx",
      "loading.tsx",
      "api/_helpers.ts",
      "api/types.d.ts",
      "api/notes.md",
      "node_modules/pkg/index.js",
    ]);
    try {
      assert.deepEqual(patterns(await scanRoutes(dir)), ["/api/users"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores route groups and parallel route directories in the URL", async () => {
    const dir = await fixture(["(admin)/api/stats/route.ts", "@modal/api/x/route.ts"]);
    try {
      assert.deepEqual(patterns(await scanRoutes(dir)).sort(), ["/api/stats", "/api/x"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list for a directory that does not exist", async () => {
    assert.deepEqual(await scanRoutes("/definitely/not/here"), []);
  });
});

describe("matchRoute", () => {
  let dir: string;
  let routes: MockRoute[];

  before(async () => {
    dir = await fixture([
      "api/users/route.ts",
      "api/users/[id]/route.ts",
      "api/users/[id]/posts/route.ts",
      "api/files/[...path]/route.ts",
      "api/docs/[[...slug]]/route.ts",
      "api/[fallback]/route.ts",
    ]);
    routes = await scanRoutes(dir);
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("prefers a static route over a dynamic one", () => {
    const match = matchRoute(routes, "/api/users");
    assert.equal(match?.route.pattern, "/api/users");
    assert.deepEqual(match?.params, {});
  });

  it("matches dynamic segments and captures the param", () => {
    const match = matchRoute(routes, "/api/users/42");
    assert.equal(match?.route.pattern, "/api/users/[id]");
    assert.deepEqual(match?.params, { id: "42" });
  });

  it("prefers a deeper static route over a dynamic parent", () => {
    const match = matchRoute(routes, "/api/users/42/posts");
    assert.equal(match?.route.pattern, "/api/users/[id]/posts");
    assert.deepEqual(match?.params, { id: "42" });
  });

  it("prefers a dynamic segment over a catch-all", () => {
    const match = matchRoute(routes, "/api/anything");
    assert.equal(match?.route.pattern, "/api/[fallback]");
  });

  it("captures catch-all segments as an array", () => {
    const match = matchRoute(routes, "/api/files/a/b/c.txt");
    assert.equal(match?.route.pattern, "/api/files/[...path]");
    assert.deepEqual(match?.params, { path: ["a", "b", "c.txt"] });
  });

  it("does not let a catch-all match zero segments", () => {
    const match = matchRoute(routes, "/api/files");
    assert.notEqual(match?.route.pattern, "/api/files/[...path]");
  });

  it("lets an optional catch-all match its own base path", () => {
    const bare = matchRoute(routes, "/api/docs");
    assert.equal(bare?.route.pattern, "/api/docs/[[...slug]]");
    assert.deepEqual(bare?.params, { slug: [] });

    const deep = matchRoute(routes, "/api/docs/a/b");
    assert.equal(deep?.route.pattern, "/api/docs/[[...slug]]");
    assert.deepEqual(deep?.params, { slug: ["a", "b"] });
  });

  it("decodes percent-encoded param values", () => {
    const match = matchRoute(routes, "/api/users/hello%20world");
    assert.deepEqual(match?.params, { id: "hello world" });
  });

  it("returns undefined when nothing matches", () => {
    assert.equal(matchRoute(routes, "/not/mocked"), undefined);
  });

  it("returns undefined for malformed encoding instead of throwing", () => {
    assert.equal(matchRoute(routes, "/api/users/%zz"), undefined);
  });
});
