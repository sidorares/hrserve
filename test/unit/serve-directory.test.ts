import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Route } from "playwright";
import { serveDirectoryListing } from "../../lib/serve-directory";

interface CapturedResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer;
}

function fakeRoute(): { route: Route; captured: CapturedResponse } {
  const captured: CapturedResponse = {};
  const route = {
    async fulfill(options: CapturedResponse) {
      Object.assign(captured, options);
    },
  } as unknown as Route;
  return { route, captured };
}

describe("serveDirectoryListing", () => {
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-listing-"));
    await fs.writeFile(path.join(dir, "style.css"), "h1 { color: red; }");
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "sub", "note.txt"), "note");
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("renders an HTML listing of the root directory", async () => {
    const { route, captured } = fakeRoute();
    await serveDirectoryListing(dir, route, "/");

    assert.equal(captured.status, 200);
    assert.match(captured.headers?.["content-type"] ?? "", /text\/html/);
    const body = captured.body?.toString() ?? "";
    assert.match(body, /style\.css/);
    assert.match(body, /sub/);
  });

  it("renders a listing for a subdirectory", async () => {
    const { route, captured } = fakeRoute();
    await serveDirectoryListing(dir, route, "/sub/");

    assert.equal(captured.status, 200);
    assert.match(captured.body?.toString() ?? "", /note\.txt/);
  });

  it("adds the leading slash when the caller omits it", async () => {
    const { route, captured } = fakeRoute();
    await serveDirectoryListing(dir, route, "sub/");

    assert.equal(captured.status, 200);
    assert.match(captured.body?.toString() ?? "", /note\.txt/);
  });

  it("responds 404 for a missing path", async () => {
    const { route, captured } = fakeRoute();
    await serveDirectoryListing(dir, route, "/nope.png");

    assert.equal(captured.status, 404);
    assert.ok((captured.body?.length ?? 0) > 0, "404 page should have a body");
  });
});
