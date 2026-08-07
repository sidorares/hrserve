import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { normalizeBaseUrl, resolveRequest } from "../../lib/resolve-request";

describe("normalizeBaseUrl", () => {
  it("appends a trailing slash when missing", () => {
    assert.equal(normalizeBaseUrl("http://localhost:3000"), "http://localhost:3000/");
  });

  it("keeps an existing trailing slash", () => {
    assert.equal(normalizeBaseUrl("http://localhost:3000/"), "http://localhost:3000/");
  });
});

describe("resolveRequest", () => {
  let dir: string;
  const base = "http://localhost:3000/";

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-resolve-"));
    await fs.writeFile(path.join(dir, "index.html"), "<h1>root</h1>");
    await fs.writeFile(path.join(dir, "style.css"), "h1 { color: red; }");
    await fs.writeFile(path.join(dir, "with space.html"), "<h1>spaced</h1>");
    await fs.writeFile(path.join(dir, "LICENSE"), "MIT");
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "sub", "note.txt"), "note");
    await fs.mkdir(path.join(dir, "app"));
    await fs.writeFile(path.join(dir, "app", "index.html"), "<h1>app</h1>");
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("serves index.html for the root URL", async () => {
    const resolved = await resolveRequest(dir, base, "http://localhost:3000/");
    assert.deepEqual(resolved, {
      kind: "file",
      filePath: path.join(dir, "index.html"),
      mimeType: "text/html",
    });
  });

  it("handles a base URL without a trailing slash", async () => {
    const resolved = await resolveRequest(dir, "http://localhost:3000", "http://localhost:3000/");
    assert.equal(resolved.kind, "file");
  });

  it("resolves a plain file with its MIME type", async () => {
    const resolved = await resolveRequest(dir, base, "http://localhost:3000/style.css");
    assert.deepEqual(resolved, {
      kind: "file",
      filePath: path.join(dir, "style.css"),
      mimeType: "text/css",
    });
  });

  it("ignores query strings", async () => {
    const resolved = await resolveRequest(dir, base, "http://localhost:3000/style.css?v=2");
    assert.equal(resolved.kind, "file");
  });

  it("decodes percent-encoded paths", async () => {
    const resolved = await resolveRequest(dir, base, "http://localhost:3000/with%20space.html");
    assert.deepEqual(resolved, {
      kind: "file",
      filePath: path.join(dir, "with space.html"),
      mimeType: "text/html",
    });
  });

  it("serves index.html of a subdirectory that has one", async () => {
    const resolved = await resolveRequest(dir, base, "http://localhost:3000/app");
    assert.deepEqual(resolved, {
      kind: "file",
      filePath: path.join(dir, "app", "index.html"),
      mimeType: "text/html",
    });
  });

  it("falls back to a listing for a directory without index.html", async () => {
    const resolved = await resolveRequest(dir, base, "http://localhost:3000/sub/");
    assert.deepEqual(resolved, { kind: "fallback", urlPath: "/sub/" });
  });

  it("falls back for a missing file, preserving the URL path", async () => {
    const resolved = await resolveRequest(dir, base, "http://localhost:3000/nope.png");
    assert.deepEqual(resolved, { kind: "fallback", urlPath: "/nope.png" });
  });

  it("returns unknown-type for existing files without a known extension", async () => {
    const resolved = await resolveRequest(dir, base, "http://localhost:3000/LICENSE");
    assert.equal(resolved.kind, "unknown-type");
  });

  it("works with a relative dir (path.join must not corrupt the fallback path)", async () => {
    const relativeDir = path.relative(process.cwd(), dir);
    const file = await resolveRequest(relativeDir, base, "http://localhost:3000/style.css");
    assert.equal(file.kind, "file");
    assert.equal(
      path.resolve((file as { filePath: string }).filePath),
      path.join(dir, "style.css")
    );

    const missing = await resolveRequest(relativeDir, base, "http://localhost:3000/nope.html");
    assert.deepEqual(missing, { kind: "fallback", urlPath: "/nope.html" });
  });

  it("does not capture other origins that share the base as a string prefix", async () => {
    const resolved = await resolveRequest(dir, base, "http://localhost:30001/style.css");
    assert.deepEqual(resolved, { kind: "pass" });
  });

  it("does not capture sibling paths that share the base path as a string prefix", async () => {
    const resolved = await resolveRequest(dir, "http://host/app", "http://host/apple/style.css");
    assert.deepEqual(resolved, { kind: "pass" });
  });

  it("passes through unrelated origins", async () => {
    const resolved = await resolveRequest(dir, base, "https://example.com/style.css");
    assert.deepEqual(resolved, { kind: "pass" });
  });

  it("rejects traversal via percent-encoded slashes", async () => {
    const resolved = await resolveRequest(
      dir,
      base,
      "http://localhost:3000/x%2f..%2f..%2f..%2fetc%2fpasswd"
    );
    assert.deepEqual(resolved, { kind: "forbidden" });
  });

  it("rejects malformed percent-encoding", async () => {
    const resolved = await resolveRequest(dir, base, "http://localhost:3000/%zz");
    assert.deepEqual(resolved, { kind: "forbidden" });
  });

  it("resolves paths under a base URL with a subpath", async () => {
    const resolved = await resolveRequest(dir, "http://host/app/", "http://host/app/style.css");
    assert.deepEqual(resolved, {
      kind: "file",
      filePath: path.join(dir, "style.css"),
      mimeType: "text/css",
    });
  });
});
