import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import chokidar from "chokidar";
import { validate } from "csstree-validator";
import type { Browser, CDPSession, Page, Request, Route } from "playwright";
import { IMAGE_MIME_TYPES, reloadImage } from "./reload-image";
import { resolveRequest } from "./resolve-request";
import { serveDirectoryListing } from "./serve-directory";

interface ServeOptions {
  url: string;
  dir: string;
  width?: number;
  height?: number;
  /** Log request routing and CDP events. */
  verbose?: boolean;
  /**
   * @deprecated Has no effect: devtools can only be enabled when launching the
   * browser, e.g. `chromium.launch({ devtools: true })`.
   */
  devtools?: boolean;
}

interface PatchEvent {
  fileName: string;
  url?: string;
  mimeType: string;
}

interface NewResourceEvent {
  url: string;
  mimeType: string;
}

interface HRServer extends EventEmitter {
  serve(options: ServeOptions): Promise<Page>;
  /** Stop watching files. Does not close the browser (the caller owns it). */
  close(): Promise<void>;
  on(event: "patch", listener: (data: PatchEvent) => void): this;
  on(event: "new-resource", listener: (data: NewResourceEvent) => void): this;
  emit(event: "patch", data: PatchEvent): boolean;
  emit(event: "new-resource", data: NewResourceEvent): boolean;
}

interface PatchContext {
  page: Page;
  /** The CDP session created in serve(). Patchers must use this session:
   * script/stylesheet ids from Debugger.scriptParsed / CSS.styleSheetAdded are
   * only valid on the session whose enable() produced them. */
  cdp: CDPSession;
}

type PatcherFunction = (
  ctx: PatchContext,
  url: string,
  newContent?: string,
  fileName?: string
) => Promise<void>;

interface ScriptDetails {
  scriptId: string;
  executionContextId?: number;
  url: string;
}

export function createServer(browser: Browser): HRServer {
  const server = new EventEmitter() as HRServer;
  const watchers = new Map<string, chokidar.FSWatcher>();
  const patchers = new Map<string, PatcherFunction>();
  const scriptUrlToDetails = new Map<string, ScriptDetails>();
  const stylesheetUrlToId = new Map<string, string>();
  let log: (...args: unknown[]) => void = () => {};

  // Setup patchers for different MIME types
  patchers.set("text/css", async ({ cdp }, url, newContent, fileName) => {
    if (!newContent || !fileName) return;

    const validationResult = validate(newContent, fileName);
    // TODO: config / cli option to allow patching invalid css
    if (validationResult.length) {
      console.warn("CSS validation failed:", validationResult);
      return;
    }
    const styleSheetId = stylesheetUrlToId.get(url);
    if (!styleSheetId) {
      log("no known stylesheet for", url);
      return;
    }
    try {
      await cdp.send("CSS.setStyleSheetText", {
        styleSheetId,
        text: newContent,
      });
    } catch (e) {
      console.warn("Error setting stylesheet text", e);
    }
  });

  for (const mimeType of IMAGE_MIME_TYPES) {
    patchers.set(mimeType, async ({ page }, url) => {
      await reloadImage(page, url);
    });
  }

  let liveEditUnavailableWarned = false;
  const patchScript: PatcherFunction = async ({ cdp }, url, scriptSource) => {
    if (!scriptSource) return;

    const scriptDetails = scriptUrlToDetails.get(url);
    if (!scriptDetails) {
      log("no known script for", url);
      return;
    }
    try {
      const result = await cdp.send("Debugger.setScriptSource", {
        scriptId: scriptDetails.scriptId,
        scriptSource,
        allowTopFrameEditing: true,
      });
      if (result.status !== "Ok") {
        console.warn("Failed to patch script", result);
      }
    } catch (e) {
      // Chromium removed LiveEdit (Debugger.setScriptSource) in 2025. The
      // script-patch event below is the reliable way for pages to react.
      if (!liveEditUnavailableWarned) {
        liveEditUnavailableWarned = true;
        console.warn("Live script patching unavailable in this browser:", (e as Error).message);
      }
    }

    // Let page code react to the change (e.g. re-run initialization).
    const detail = JSON.stringify({ detail: { scriptUrl: url } });
    await cdp.send("Runtime.evaluate", {
      expression: `window.dispatchEvent(new CustomEvent('script-patch', ${detail}))`,
    });
  };
  // mime-db has historically flip-flopped between the two names for .js
  patchers.set("application/javascript", patchScript);
  patchers.set("text/javascript", patchScript);

  patchers.set("text/html", async ({ cdp }, _url, newContent) => {
    if (!newContent) return;

    const {
      root: { nodeId: rootNodeId },
    } = await cdp.send("DOM.getDocument");
    await cdp.send("DOM.setOuterHTML", {
      nodeId: rootNodeId,
      outerHTML: newContent,
    });
  });

  // Main server functionality
  server.serve = async (options: ServeOptions): Promise<Page> => {
    const { url: targetUrl, dir, width = 1280, height = 720, verbose = false } = options;
    if (verbose) {
      log = (...args: unknown[]) => console.log(...args);
    }

    const context = await browser.newContext({
      viewport: { width, height },
    });
    const page = await context.newPage();

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Debugger.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Page.enable");
    await cdp.send("CSS.enable");
    await cdp.send("Runtime.enable");

    cdp.on("Debugger.scriptParsed", (event) => {
      scriptUrlToDetails.set(event.url, event as ScriptDetails);
    });

    cdp.on("CSS.styleSheetAdded", (event) => {
      stylesheetUrlToId.set(event.header.sourceURL, event.header.styleSheetId);
      log("CSS.styleSheetAdded", event.header.sourceURL, "->", event.header.styleSheetId);
    });

    cdp.on("CSS.styleSheetRemoved", (event) => {
      for (const [url, id] of stylesheetUrlToId.entries()) {
        if (id === event.styleSheetId) {
          stylesheetUrlToId.delete(url);
          log("CSS.styleSheetRemoved", url, "->", event.styleSheetId);
          break;
        }
      }
    });

    const watchEvent = (name: string) => {
      // Using unknown instead of any for better type safety
      (
        cdp as {
          on: (event: string, listener: (event: unknown) => void) => void;
        }
      ).on(name, (event: unknown) => {
        // we'll be reacting on content change
        // to allow bidirectional sync
        // ( for example, "Edit as HTML in devtools" -> file content updated on fs)
        // see https://github.com/sidorares/hrserve/issues/12
        log(name, event);
      });
    };

    watchEvent("CSS.styleSheetChanged");
    watchEvent("DOM.attributeModified");
    watchEvent("DOM.attributeRemoved");
    watchEvent("DOM.characterDataModified");
    watchEvent("DOM.childNodeCountUpdated");
    watchEvent("DOM.childNodeInserted");
    watchEvent("DOM.childNodeRemoved");
    watchEvent("DOM.distributedNodesUpdated");
    watchEvent("DOM.inlineStyleInvalidated");
    watchEvent("DOM.pseudoElementAdded");
    watchEvent("DOM.pseudoElementRemoved");
    watchEvent("DOM.setChildNodes");
    watchEvent("DOM.shadowRootPopped");
    watchEvent("DOM.shadowRootPushed");
    watchEvent("DOM.documentUpdated");
    watchEvent("DOM.topLayerElementUpdated");

    // Use Playwright's route API for request interception
    await page.route("**/*", async (route: Route, request: Request) => {
      if (request.method() !== "GET") {
        return route.continue();
      }

      const url = request.url();
      const resolved = await resolveRequest(dir, targetUrl, url);
      log("request", url, "->", resolved.kind);

      switch (resolved.kind) {
        case "pass":
          return route.continue();
        case "forbidden":
        case "unknown-type":
          return route.fulfill({ status: 404 });
        case "fallback":
          // serve-handler renders the directory listing / 404 page
          return serveDirectoryListing(dir, route, resolved.urlPath);
        case "file": {
          const { filePath, mimeType } = resolved;
          const body = await fs.readFile(filePath);
          await route.fulfill({
            body,
            status: 200,
            headers: {
              "Content-Type": mimeType,
              "Cache-Control": "max-age=0, must-revalidate, no-store",
            },
          });

          const patcher = patchers.get(mimeType);
          if (patcher && !watchers.has(url)) {
            const watcher = chokidar.watch(filePath);
            watcher.on("change", async () => {
              try {
                const newContent = await fs.readFile(filePath, "utf-8");
                await patcher({ page, cdp }, url, newContent, filePath);
                server.emit("patch", { fileName: filePath, url, mimeType });
              } catch (e) {
                console.warn("Failed to patch", filePath, e);
              }
            });
            server.emit("new-resource", { url, mimeType });
            watchers.set(url, watcher);
          }
          return;
        }
      }
    });

    await page.goto(targetUrl);
    return page;
  };

  server.close = async () => {
    const closing = [...watchers.values()].map((watcher) => watcher.close());
    watchers.clear();
    await Promise.all(closing);
  };

  return server;
}
