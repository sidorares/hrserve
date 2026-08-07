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
  // (https://developer.chrome.com/blog/devtools-deprecates-live-editing), so
  // the in-place body swap can no longer be asserted; the guaranteed contract
  // is the script-patch event that lets page code react to the change.
  it("dispatches script-patch on the page when JavaScript changes", async () => {
    const dir = await makeFixture({
      "index.html":
        '<!DOCTYPE html><html><head><script src="app.js"></script></head>' +
        "<body><h1>js</h1></body></html>",
      "app.js": 'window.getValue = function () { return "v1"; };\n',
    });
    const server = createServer(browser);
    let page: Page | undefined;
    try {
      page = await server.serve({ url: "http://js.hrserve.test/", dir });
      await page.evaluate(() => {
        const w = window as unknown as { __patchedScripts: string[] };
        w.__patchedScripts = [];
        window.addEventListener("script-patch", (event) => {
          w.__patchedScripts.push((event as CustomEvent<{ scriptUrl: string }>).detail.scriptUrl);
        });
      });
      assert.equal(
        await page.evaluate(() => (window as unknown as { getValue(): string }).getValue()),
        "v1"
      );

      await watcherSettle();
      const patched = once(server, "patch", { signal: AbortSignal.timeout(PATCH_TIMEOUT) });
      await fs.writeFile(
        path.join(dir, "app.js"),
        'window.getValue = function () { return "v2"; };\n'
      );
      const [event] = await patched;
      assert.equal(event.url, "http://js.hrserve.test/app.js");

      // The page is notified so it can re-run initialization
      const notified = await waitFor(
        () =>
          (page as Page).evaluate(
            () => (window as unknown as { __patchedScripts: string[] }).__patchedScripts
          ),
        (urls) => urls.length > 0
      );
      assert.deepEqual(notified, ["http://js.hrserve.test/app.js"]);

      // The page kept running (not reloaded); the original function is intact
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
