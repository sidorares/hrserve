import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type ResolveConfig, normalizeBaseUrl, resolveRequest } from "../../lib/resolve-request";
import { type Rule, normalizeRules } from "../../lib/rules";

/** Build the config serve() would build for a given base URL / dir / rules. */
function config(baseUrl: string, dir?: string, rules?: Rule[]): ResolveConfig {
  return { baseUrl: normalizeBaseUrl(baseUrl), rules: normalizeRules(rules, dir) };
}

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
  let plain: ResolveConfig;

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
    plain = config(base, dir);
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("serves index.html for the root URL", async () => {
    const resolved = await resolveRequest(plain, "http://localhost:3000/");
    assert.deepEqual(resolved, {
      kind: "file",
      filePath: path.join(dir, "index.html"),
      mimeType: "text/html",
    });
  });

  it("handles a base URL without a trailing slash", async () => {
    const resolved = await resolveRequest(config("http://localhost:3000", dir), base);
    assert.equal(resolved.kind, "file");
  });

  it("resolves a plain file with its MIME type", async () => {
    const resolved = await resolveRequest(plain, "http://localhost:3000/style.css");
    assert.deepEqual(resolved, {
      kind: "file",
      filePath: path.join(dir, "style.css"),
      mimeType: "text/css",
    });
  });

  it("ignores query strings", async () => {
    const resolved = await resolveRequest(plain, "http://localhost:3000/style.css?v=2");
    assert.equal(resolved.kind, "file");
  });

  it("decodes percent-encoded paths", async () => {
    const resolved = await resolveRequest(plain, "http://localhost:3000/with%20space.html");
    assert.deepEqual(resolved, {
      kind: "file",
      filePath: path.join(dir, "with space.html"),
      mimeType: "text/html",
    });
  });

  it("serves index.html of a subdirectory that has one", async () => {
    const resolved = await resolveRequest(plain, "http://localhost:3000/app");
    assert.deepEqual(resolved, {
      kind: "file",
      filePath: path.join(dir, "app", "index.html"),
      mimeType: "text/html",
    });
  });

  it("falls back to a listing for a directory without index.html", async () => {
    const resolved = await resolveRequest(plain, "http://localhost:3000/sub/");
    assert.deepEqual(resolved, { kind: "fallback", urlPath: "/sub/", dir });
  });

  it("falls back for a missing file, preserving the URL path", async () => {
    const resolved = await resolveRequest(plain, "http://localhost:3000/nope.png");
    assert.deepEqual(resolved, { kind: "fallback", urlPath: "/nope.png", dir });
  });

  it("returns unknown-type for existing files without a known extension", async () => {
    const resolved = await resolveRequest(plain, "http://localhost:3000/LICENSE");
    assert.equal(resolved.kind, "unknown-type");
  });

  it("works with a relative dir (path.join must not corrupt the fallback path)", async () => {
    const relativeDir = path.relative(process.cwd(), dir);
    const relative = config(base, relativeDir);
    const file = await resolveRequest(relative, "http://localhost:3000/style.css");
    assert.equal(file.kind, "file");
    assert.equal(
      path.resolve((file as { filePath: string }).filePath),
      path.join(dir, "style.css")
    );

    const missing = await resolveRequest(relative, "http://localhost:3000/nope.html");
    assert.deepEqual(missing, { kind: "fallback", urlPath: "/nope.html", dir: relativeDir });
  });

  it("does not capture other origins that share the base as a string prefix", async () => {
    const resolved = await resolveRequest(plain, "http://localhost:30001/style.css");
    assert.deepEqual(resolved, { kind: "pass" });
  });

  it("does not capture sibling paths that share the base path as a string prefix", async () => {
    const resolved = await resolveRequest(
      config("http://host/app", dir),
      "http://host/apple/style.css"
    );
    assert.deepEqual(resolved, { kind: "pass" });
  });

  it("passes through unrelated origins", async () => {
    const resolved = await resolveRequest(plain, "https://example.com/style.css");
    assert.deepEqual(resolved, { kind: "pass" });
  });

  it("rejects traversal via percent-encoded slashes", async () => {
    const resolved = await resolveRequest(
      plain,
      "http://localhost:3000/x%2f..%2f..%2f..%2fetc%2fpasswd"
    );
    assert.deepEqual(resolved, { kind: "forbidden" });
  });

  it("rejects malformed percent-encoding", async () => {
    const resolved = await resolveRequest(plain, "http://localhost:3000/%zz");
    assert.deepEqual(resolved, { kind: "forbidden" });
  });

  it("resolves paths under a base URL with a subpath", async () => {
    const resolved = await resolveRequest(
      config("http://host/app/", dir),
      "http://host/app/style.css"
    );
    assert.deepEqual(resolved, {
      kind: "file",
      filePath: path.join(dir, "style.css"),
      mimeType: "text/css",
    });
  });

  it("passes non-GET methods through to the network when serving files", async () => {
    const resolved = await resolveRequest(plain, "http://localhost:3000/style.css", "POST");
    assert.deepEqual(resolved, { kind: "pass" });
  });

  describe("routing rules", () => {
    it("serves only paths matched by a serve rule", async () => {
      const scoped = config(base, dir, [{ match: "/sub/**", action: "serve" }]);
      assert.equal(
        (await resolveRequest(scoped, "http://localhost:3000/sub/note.txt")).kind,
        "file"
      );
      // outside the rule: not ours, goes to the network
      assert.deepEqual(await resolveRequest(scoped, "http://localhost:3000/style.css"), {
        kind: "pass",
      });
    });

    it("applies the first matching rule", async () => {
      const ordered = config(base, dir, [
        { match: "/api/**", action: "upstream" },
        { match: "**", action: "serve" },
      ]);
      assert.deepEqual(await resolveRequest(ordered, "http://localhost:3000/api/users"), {
        kind: "pass",
      });
      assert.equal((await resolveRequest(ordered, "http://localhost:3000/style.css")).kind, "file");
    });

    it("serves different directories from different rules", async () => {
      const other = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-alt-"));
      await fs.writeFile(path.join(other, "alt.css"), "h1 {}");
      try {
        const mounted = config(base, dir, [
          { match: "/ui/**", action: "serve", dir: other },
          { match: "**", action: "serve" },
        ]);
        // Rule dirs mirror the URL space below the mount, so /ui/alt.css -> <other>/ui/alt.css
        assert.deepEqual(await resolveRequest(mounted, "http://localhost:3000/ui/alt.css"), {
          kind: "fallback",
          urlPath: "/ui/alt.css",
          dir: other,
        });
        assert.equal(
          (await resolveRequest(mounted, "http://localhost:3000/style.css")).kind,
          "file"
        );
      } finally {
        await fs.rm(other, { recursive: true, force: true });
      }
    });

    it("rewrites proxied requests onto the target origin, keeping path and query", async () => {
      const proxied = config(base, dir, [
        { match: "/api/**", action: "proxy", target: "https://staging.example.com" },
      ]);
      assert.deepEqual(await resolveRequest(proxied, "http://localhost:3000/api/users?q=1"), {
        kind: "proxy",
        target: "https://staging.example.com/api/users?q=1",
      });
    });

    it("preserves a path prefix on the proxy target", async () => {
      const proxied = config(base, dir, [
        { match: "/api/**", action: "proxy", target: "https://example.com/v2/" },
      ]);
      assert.deepEqual(await resolveRequest(proxied, "http://localhost:3000/api/users"), {
        kind: "proxy",
        target: "https://example.com/v2/api/users",
      });
    });

    it("proxies every method, not just GET", async () => {
      const proxied = config(base, dir, [
        { match: "/api/**", action: "proxy", target: "https://example.com" },
      ]);
      const resolved = await resolveRequest(proxied, "http://localhost:3000/api/users", "POST");
      assert.equal(resolved.kind, "proxy");
    });

    it("honours method-scoped rules", async () => {
      const byMethod = config(base, dir, [
        { match: "/api/**", methods: ["post"], action: "proxy", target: "https://example.com" },
        { match: "**", action: "serve" },
      ]);
      assert.equal(
        (await resolveRequest(byMethod, "http://localhost:3000/api/x", "POST")).kind,
        "proxy"
      );
      // GET falls through to the serve rule
      assert.equal(
        (await resolveRequest(byMethod, "http://localhost:3000/api/x", "GET")).kind,
        "fallback"
      );
    });
  });
});

describe("normalizeRules", () => {
  it("defaults to serving everything from the top-level dir", () => {
    const rules = normalizeRules(undefined, "/tmp/site");
    assert.equal(rules.length, 1);
    assert.equal(rules[0].action, "serve");
    assert.equal(rules[0].match, "**");
    assert.equal(rules[0].dir, "/tmp/site");
  });

  it("inherits the top-level dir for serve rules that omit it", () => {
    const rules = normalizeRules([{ match: "/a/**", action: "serve" }], "/tmp/site");
    assert.equal(rules[0].dir, "/tmp/site");
  });

  it("throws when a serve rule has no directory anywhere", () => {
    assert.throws(() => normalizeRules([{ match: "/a/**", action: "serve" }]), /no directory/);
  });

  it("throws on an invalid proxy target", () => {
    assert.throws(
      () => normalizeRules([{ match: "**", action: "proxy", target: "not-a-url" }]),
      /invalid proxy target/
    );
  });

  it("does not require a dir when no serve rule is present", () => {
    const rules = normalizeRules([{ match: "**", action: "upstream" }]);
    assert.equal(rules[0].action, "upstream");
  });
});
