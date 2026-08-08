import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type Browser, type Page, chromium } from "playwright";
import { createServer } from "../../lib/hrserve";
import { reloadImage } from "../../lib/reload-image";

// 1x1 transparent PNG
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

// The fake hosts never resolve: every request must be answered by route interception.
const PATCH_TIMEOUT = 10_000;

let browser: Browser;

async function makeFixture(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-it-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return dir;
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = PATCH_TIMEOUT
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out; last value: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await read();
  }
  return last;
}

/** Give chokidar a moment to establish its watch before we modify the file. */
const watcherSettle = () => new Promise((resolve) => setTimeout(resolve, 500));

/**
 * Space out consecutive writes to the same file. Belt and braces since the
 * watchers moved to `awaitWriteFinish` (see lib/watch-options.ts), which is
 * what stops chokidar dropping every other back-to-back change; these tests
 * pass without the delay, and it is kept only to keep them insensitive to the
 * configured threshold.
 */
const betweenWrites = () => new Promise((resolve) => setTimeout(resolve, 1200));

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser.close();
});

describe("hrserve integration", () => {
  it("serves local files at the target URL, with listings and 404s", async () => {
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head>' +
        "<body><h1>hello</h1></body></html>",
      "style.css": "h1 { color: rgb(255, 0, 0); }",
      "sub/note.txt": "note",
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://serve.hrserve.test/", dir });

      assert.equal(await page.textContent("h1"), "hello");
      const color = await page.evaluate(
        () => getComputedStyle(document.querySelector("h1") as Element).color
      );
      assert.equal(color, "rgb(255, 0, 0)");

      // Directory without index.html renders a listing (via serve-handler)
      const listing = await page.evaluate(() => fetch("/sub/").then((r) => r.text()));
      assert.match(listing, /note\.txt/);

      // Missing files respond 404
      const status = await page.evaluate(() => fetch("/missing-page").then((r) => r.status));
      assert.equal(status, 404);
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("patches CSS in place without reloading the page", async () => {
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head>' +
        "<body><h1>css</h1></body></html>",
      "style.css": "h1 { color: rgb(255, 0, 0); }",
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://css.hrserve.test/", dir });
      await page.evaluate(() => {
        (window as unknown as { __noReloadMarker: number }).__noReloadMarker = 42;
      });

      await watcherSettle();
      const patched = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
      await fs.writeFile(path.join(dir, "style.css"), "h1 { color: rgb(0, 128, 0); }");
      const [event] = await patched;
      assert.equal(event.mimeType, "text/css");

      await waitFor(
        () =>
          (page as Page).evaluate(
            () => getComputedStyle(document.querySelector("h1") as Element).color
          ),
        (color) => color === "rgb(0, 128, 0)"
      );

      // The page was patched, not reloaded
      const marker = await page.evaluate(
        () => (window as unknown as { __noReloadMarker: number }).__noReloadMarker
      );
      assert.equal(marker, 42);
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not apply invalid CSS", async () => {
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head>' +
        "<body><h1>css</h1></body></html>",
      "style.css": "h1 { color: rgb(255, 0, 0); }",
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://badcss.hrserve.test/", dir });

      await watcherSettle();
      const patched = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
      await fs.writeFile(path.join(dir, "style.css"), "h1 { color: }");
      await patched;

      // give any (wrong) patch a chance to land, then check nothing changed
      await new Promise((resolve) => setTimeout(resolve, 300));
      const color = await page.evaluate(
        () => getComputedStyle(document.querySelector("h1") as Element).color
      );
      assert.equal(color, "rgb(255, 0, 0)");
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Chromium removed LiveEdit (Debugger.setScriptSource) in Chrome 145
  // (https://developer.chrome.com/blog/devtools-deprecates-live-editing), so the
  // script body can no longer be swapped in place. Instead the new source is
  // re-run (classic scripts) or re-imported (ES modules).
  const CLASSIC_SCRIPT = (version: string) =>
    [
      // A top-level const is the interesting case: re-running the source at the
      // top level of Runtime.evaluate throws "Identifier has already been
      // declared", which is why the patcher uses indirect eval.
      `const GREETING = "${version}";`,
      `var appVersion = "${version}";`,
      `window.getValue = function () { return "${version}"; };`,
      "window.__runs = (window.__runs || 0) + 1;",
    ].join("\n");

  /** Register a script-patch listener that records what it saw, before re-running. */
  const recordPatches = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as {
        __patched: { scriptUrl: string; mode: string; valueAtDispatch: unknown }[];
        __errors: string[];
        getValue?(): string;
      };
      w.__patched = [];
      w.__errors = [];
      window.addEventListener("script-patch", (event) => {
        const { scriptUrl, mode } = (event as CustomEvent<{ scriptUrl: string; mode: string }>)
          .detail;
        w.__patched.push({ scriptUrl, mode, valueAtDispatch: w.getValue?.() });
      });
      window.addEventListener("script-patch-error", (event) => {
        w.__errors.push((event as CustomEvent<{ message: string }>).detail.message);
      });
    });

  const readPatches = (page: Page) =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __patched: { scriptUrl: string; mode: string; valueAtDispatch: unknown }[];
          }
        ).__patched
    );

  it("re-runs a changed classic script in global scope", async () => {
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><script src="app.js"></script></head>' +
        "<body><h1>js</h1></body></html>",
      "app.js": CLASSIC_SCRIPT("v1"),
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://js.hrserve.test/", dir });
      await recordPatches(page);
      await page.evaluate(() => {
        (window as unknown as { __noReloadMarker: number }).__noReloadMarker = 42;
      });
      assert.equal(
        await page.evaluate(() => (window as unknown as { getValue(): string }).getValue()),
        "v1"
      );

      await watcherSettle();
      const patched = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
      await fs.writeFile(path.join(dir, "app.js"), CLASSIC_SCRIPT("v2"));
      const [event] = await patched;
      assert.equal(event.url, "http://js.hrserve.test/app.js");

      // The new source ran: the function the page calls is the new one...
      await waitFor(
        () =>
          (page as Page).evaluate(() => (window as unknown as { getValue(): string }).getValue()),
        (value) => value === "v2"
      );
      // ...and a top-level `var` still reaches the global object, as in a
      // classic script (indirect eval, not a scoped wrapper).
      assert.equal(
        await page.evaluate(() => (globalThis as unknown as { appVersion: string }).appVersion),
        "v2"
      );

      // Top-level side effects re-run — hence the cleanup event below.
      assert.equal(await page.evaluate(() => (window as unknown as { __runs: number }).__runs), 2);

      // script-patch fires *before* the new source runs, so a listener can
      // dispose of the old one while it is still the live version.
      assert.deepEqual(await readPatches(page), [
        { scriptUrl: "http://js.hrserve.test/app.js", mode: "evaluate", valueAtDispatch: "v1" },
      ]);

      // The page was patched, not reloaded
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { __noReloadMarker: number }).__noReloadMarker
        ),
        42
      );
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("re-imports a changed ES module and hands the new namespace to accept()", async () => {
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><script type="module" src="app.js"></script></head>' +
        "<body><h1>esm</h1></body></html>",
      "app.js": 'export const label = "v1";\nwindow.__loaded = true;\n',
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://esm.hrserve.test/", dir });
      await page.waitForFunction(() => (window as unknown as { __loaded?: boolean }).__loaded);
      await recordPatches(page);
      await page.evaluate(() => {
        window.addEventListener("script-patch", (event) => {
          const detail = (
            event as CustomEvent<{ accept(handler: (exports: unknown) => void): void }>
          ).detail;
          detail.accept((exports) => {
            (window as unknown as { __accepted: unknown }).__accepted = (
              exports as { label: string }
            ).label;
          });
        });
      });

      await watcherSettle();
      const patched = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
      await fs.writeFile(path.join(dir, "app.js"), 'export const label = "v2";\n');
      await patched;

      // The accept handler receives the freshly evaluated module namespace
      const accepted = await waitFor(
        () =>
          (page as Page).evaluate(
            () => (window as unknown as { __accepted?: string }).__accepted ?? null
          ),
        (value) => value !== null
      );
      assert.equal(accepted, "v2");
      assert.deepEqual(
        (await readPatches(page)).map(({ mode }) => mode),
        ["import"]
      );
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not re-import the same module twice per change", async () => {
    // The re-import request goes through route interception like any other, so
    // watching its cache-busted URL as well would double the patch events —
    // and double them again on every subsequent edit.
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><script type="module" src="app.js"></script></head>' +
        "<body><h1>esm</h1></body></html>",
      "app.js": 'export const label = "v1";\nwindow.__loaded = true;\n',
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://esm-once.hrserve.test/", dir });
      await page.waitForFunction(() => (window as unknown as { __loaded?: boolean }).__loaded);
      const events: string[] = [];
      server.on("patch", ({ url }) => events.push(url as string));

      await watcherSettle();
      for (const version of ["v2", "v3"]) {
        const patched = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
        await fs.writeFile(path.join(dir, "app.js"), `export const label = "${version}";\n`);
        await patched;
        await betweenWrites();
      }
      // allow any duplicate watcher a chance to fire
      await new Promise((resolve) => setTimeout(resolve, 500));

      assert.deepEqual(events, [
        "http://esm-once.hrserve.test/app.js",
        "http://esm-once.hrserve.test/app.js",
      ]);
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("lets the page take over the update with preventDefault()", async () => {
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><script src="app.js"></script></head>' +
        "<body><h1>js</h1></body></html>",
      "app.js": CLASSIC_SCRIPT("v1"),
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://cancel.hrserve.test/", dir });
      await recordPatches(page);
      await page.evaluate(() => {
        window.addEventListener("script-patch", (event) => event.preventDefault());
      });

      await watcherSettle();
      const patched = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
      await fs.writeFile(path.join(dir, "app.js"), CLASSIC_SCRIPT("v2"));
      await patched;

      // The page was notified but the new source never ran
      await waitFor(
        () => readPatches(page as Page),
        (seen) => seen.length > 0
      );
      assert.equal(
        await page.evaluate(() => (window as unknown as { getValue(): string }).getValue()),
        "v1"
      );
      assert.equal(await page.evaluate(() => (window as unknown as { __runs: number }).__runs), 1);
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a broken update without taking the page down", async () => {
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><script src="app.js"></script></head>' +
        "<body><h1>js</h1></body></html>",
      "app.js": CLASSIC_SCRIPT("v1"),
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://broken.hrserve.test/", dir });
      await recordPatches(page);

      await watcherSettle();
      const patched = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
      await fs.writeFile(path.join(dir, "app.js"), "this is not valid javascript(");
      await patched;

      const errors = await waitFor(
        () => (page as Page).evaluate(() => (window as unknown as { __errors: string[] }).__errors),
        (seen) => seen.length > 0
      );
      assert.equal(errors.length, 1);
      assert.match(errors[0], /Unexpected|Invalid|SyntaxError/i);

      // The old version is still running
      assert.equal(
        await page.evaluate(() => (window as unknown as { getValue(): string }).getValue()),
        "v1"
      );
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('only notifies the page when scriptReload is "off"', async () => {
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><script src="app.js"></script></head>' +
        "<body><h1>js</h1></body></html>",
      "app.js": CLASSIC_SCRIPT("v1"),
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://noreload.hrserve.test/", dir, scriptReload: "off" });
      await recordPatches(page);

      await watcherSettle();
      const patched = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
      await fs.writeFile(path.join(dir, "app.js"), CLASSIC_SCRIPT("v2"));
      await patched;

      const seen = await waitFor(
        () => readPatches(page as Page),
        (patches) => patches.length > 0
      );
      assert.deepEqual(
        seen.map(({ mode }) => mode),
        ["none"]
      );
      assert.equal(
        await page.evaluate(() => (window as unknown as { getValue(): string }).getValue()),
        "v1"
      );
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("dispatches script-patch even when the debugger never registered the script", async () => {
    // A JS file that is fetched but never executed as a <script> produces no
    // Debugger.scriptParsed event, so hrserve has no scriptId for it. The
    // documented script-patch contract must hold anyway — CI hit exactly this.
    const dir = await makeFixture({
      "index.html": "<!DOCTYPE html><html><body><h1>fetched</h1></body></html>",
      "lib.js": 'export const value = "v1";\n',
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://fetched.hrserve.test/", dir });
      await page.evaluate(() => {
        const w = window as unknown as { __patchedScripts: string[] };
        w.__patchedScripts = [];
        window.addEventListener("script-patch", (event) => {
          w.__patchedScripts.push((event as CustomEvent<{ scriptUrl: string }>).detail.scriptUrl);
        });
      });
      // Fetching it is enough for hrserve to serve and watch it
      await page.evaluate(() => fetch("/lib.js").then((r) => r.text()));

      await watcherSettle();
      const patched = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
      await fs.writeFile(path.join(dir, "lib.js"), 'export const value = "v2";\n');
      const [event] = await patched;
      assert.equal(event.applied, false, "without scriptParsed we cannot tell how to re-run it");
      assert.match(event.reason ?? "", /script-patch event dispatched/);

      const notified = await waitFor(
        () =>
          (page as Page).evaluate(
            () => (window as unknown as { __patchedScripts: string[] }).__patchedScripts
          ),
        (urls) => urls.length > 0
      );
      assert.deepEqual(notified, ["http://fetched.hrserve.test/lib.js"]);
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces the DOM when HTML changes", async () => {
    const dir = await makeFixture({
      "index.html": "<!DOCTYPE html><html><body><h1>one</h1></body></html>",
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://html.hrserve.test/", dir });
      assert.equal(await page.textContent("h1"), "one");

      await watcherSettle();
      const patched = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
      await fs.writeFile(
        path.join(dir, "index.html"),
        "<!DOCTYPE html><html><body><h1>two</h1></body></html>"
      );
      await patched;

      await waitFor(
        () => (page as Page).evaluate(() => document.querySelector("h1")?.textContent ?? ""),
        (text) => text === "two"
      );
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("emits a single patch event per change", async () => {
    const dir = await makeFixture({
      "index.html": "<!DOCTYPE html><html><body><h1>one</h1></body></html>",
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://emit.hrserve.test/", dir });
      const events: string[] = [];
      server.on("patch", ({ mimeType }) => events.push(mimeType));

      await watcherSettle();
      await fs.writeFile(
        path.join(dir, "index.html"),
        "<!DOCTYPE html><html><body><h1>two</h1></body></html>"
      );
      await waitFor(
        async () => events.length,
        (count) => count >= 1
      );
      // allow a moment for any (wrong) duplicate emit
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(events, ["text/html"]);
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // The mock-handler equivalent lives in mock-api.test.ts; this covers the
  // other watcher, where a dropped change costs a patch rather than a stale
  // module. Both paths go through watchOptions(), and both need a test that
  // writes inside the 50ms window chokidar would otherwise throttle away.
  it("patches both of two edits made back to back", async () => {
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head>' +
        "<body><h1>twice</h1></body></html>",
      "style.css": "h1 { color: rgb(255, 0, 0); }",
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://twice.hrserve.test/", dir });
      const cssPath = path.join(dir, "style.css");

      await watcherSettle();
      const first = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
      await fs.writeFile(cssPath, "h1 { color: rgb(0, 128, 0); }");
      const [firstEvent] = await first;
      assert.equal(firstEvent.applied, true);

      // Deliberately no betweenWrites() here — spacing the writes out is what
      // this test exists to avoid. A patch event arrives well inside chokidar's
      // 50ms change throttle, so the second write lands in the window that used
      // to swallow it.
      const second = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
      await fs.writeFile(cssPath, "h1 { color: rgb(0, 0, 255); }");
      const [secondEvent] = await second;
      assert.equal(secondEvent.applied, true);
      assert.equal(secondEvent.fileName, cssPath);

      // ...and it is the second edit that is in the page
      await waitFor(
        () =>
          (page as Page).evaluate(
            () => getComputedStyle(document.querySelector("h1") as Element).color
          ),
        (color) => color === "rgb(0, 0, 255)"
      );
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reloads images with a cache buster, including CSS backgrounds", async () => {
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><style>body { background-image: url("img.png"); }</style>' +
        '</head><body><img id="pic" src="img.png"></body></html>',
      "img.png": PNG_1PX,
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://img.hrserve.test/", dir });

      const first = await reloadImage(page, "http://img.hrserve.test/img.png");
      assert.equal(first.updatedCount, 2, "should update both the <img> and the CSS rule");

      const state = await page.evaluate(() => ({
        imgSrc: (document.querySelector("#pic") as HTMLImageElement).src,
        cssValue: (document.styleSheets[0].cssRules[0] as CSSStyleRule).style.getPropertyValue(
          "background-image"
        ),
      }));
      assert.match(state.imgSrc, /img\.png\?_t=\d+/);
      assert.match(state.cssValue, /img\.png\?_t=\d+/);

      // A second reload replaces the cache buster instead of stacking another one
      const second = await reloadImage(page, "http://img.hrserve.test/img.png");
      assert.equal(second.updatedCount, 2);
      const after = await page.evaluate(
        () => (document.querySelector("#pic") as HTMLImageElement).src
      );
      assert.equal(after.match(/_t=/g)?.length, 1);
    } finally {
      await page?.context().close();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
