import { EventEmitter } from "node:events";
import chokidar from "chokidar";
import mime from "mime-types";
import fs from "node:fs/promises";
import path from "node:path";
import { validate } from "csstree-validator";
import { reloadImage, IMAGE_MIME_TYPES } from "./reload-image";
import type { Browser, Page, Route, Request } from "playwright";
import { serveDirectoryListing } from "./serve-directory";
interface ServeOptions {
  url: string;
  dir: string;
  width?: number;
  height?: number;
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
  on(event: "patch", listener: (data: PatchEvent) => void): this;
  on(event: "new-resource", listener: (data: NewResourceEvent) => void): this;
  emit(event: "patch", data: PatchEvent): boolean;
  emit(event: "new-resource", data: NewResourceEvent): boolean;
}

type PatcherFunction = (
  page: Page,
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

  // Setup patchers for different MIME types
  patchers.set(
    "text/css",
    async (page: Page, url: string, newContent?: string, fileName?: string) => {
      if (!newContent || !fileName) return;

      const validationResult = validate(newContent, fileName);
      // TODO: config / cli option to allow patching invalid css
      if (validationResult.length) {
        console.log("CSS validation failed:", validationResult);
        return;
      }
      const cdp = await page.context().newCDPSession(page);
      const styleSheetId = stylesheetUrlToId.get(url);
      if (styleSheetId) {
        try {
          await cdp.send("CSS.setStyleSheetText", {
            styleSheetId,
            text: newContent,
          });
        } catch (e) {
          console.log("Error setting stylesheet text", e);
        }
      }
    }
  );

  for (const mimeType of IMAGE_MIME_TYPES) {
    patchers.set(mimeType, async (page: Page, url: string) => {
      await reloadImage(page, url);
    });
  }

  patchers.set(
    "application/javascript",
    async (page: Page, url: string, scriptSource?: string, fileName?: string) => {
      if (!scriptSource || !fileName) return;

      const cdp = await page.context().newCDPSession(page);
      const scriptDetails = scriptUrlToDetails.get(url);
      if (!scriptDetails) {
        return;
      }
      await cdp.send("Debugger.enable");
      const result = await cdp.send("Debugger.setScriptSource", {
        scriptId: scriptDetails.scriptId,
        scriptSource,
        allowTopFrameEditing: true,
      });

      if (result.status !== "Ok") {
        console.log("Failed to patch script", result);
        return;
      }

      const detail = JSON.stringify({
        detail: {
          scriptUrl: url,
        },
      });
      const expression = `(function() {
          const event = new CustomEvent(
            'script-patch',
            ${detail}  
          );
          window.dispatchEvent(event);
        })();`;

      await cdp.send("Runtime.evaluate", {
        expression,
      });

      try {
        console.log("evaluating in script context", scriptDetails.executionContextId);
        const r = await cdp.send("Runtime.evaluate", {
          expression: "import.meta",
          contextId: scriptDetails.executionContextId,
        });
        console.log("Runtime.evaluate", r);
      } catch (e) {
        console.log("Error evaluating", e);
      }

      server.emit("patch", { fileName, mimeType: "application/javascript" });
    }
  );

  patchers.set(
    "text/html",
    async (page: Page, _url: string, newContent?: string, fileName?: string) => {
      if (!newContent || !fileName) return;

      const cdp = await page.context().newCDPSession(page);
      const {
        root: { nodeId: rootNodeId },
      } = await cdp.send("DOM.getDocument");
      await cdp.send("DOM.setOuterHTML", {
        nodeId: rootNodeId,
        outerHTML: newContent,
      });
      server.emit("patch", { fileName, mimeType: "text/html" });
    }
  );

  // Main server functionality
  server.serve = async (options: ServeOptions): Promise<Page> => {
    const { url: targetUrl, dir, width = 1280, height = 720 } = options;

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
      console.log("=== CSS.styleSheetAdded ===");
      console.log("New styleSheetId:", event.header.styleSheetId);
      console.log("Source URL:", event.header.sourceURL);
      console.log("Origin:", event.header.origin);
      console.log("Is inline:", event.header.isInline);
      console.log("Is disabled:", event.header.disabled);

      stylesheetUrlToId.set(event.header.sourceURL, event.header.styleSheetId);
      console.log("Added to map:", event.header.sourceURL, "->", event.header.styleSheetId);
      console.log("Total stylesheets in map:", stylesheetUrlToId.size);
      console.log("=== END styleSheetAdded ===");
    });

    cdp.on("CSS.styleSheetRemoved", (event) => {
      console.log("=== CSS.styleSheetRemoved ===");
      console.log("Removed styleSheetId:", event.styleSheetId);

      // Find and remove the URL mapping for this styleSheetId
      let removedUrl = null;
      for (const [url, id] of stylesheetUrlToId.entries()) {
        if (id === event.styleSheetId) {
          removedUrl = url;
          stylesheetUrlToId.delete(url);
          break;
        }
      }

      if (removedUrl) {
        console.log("Removed URL mapping:", removedUrl, "->", event.styleSheetId);
      } else {
        console.log("No URL mapping found for removed styleSheetId:", event.styleSheetId);
      }

      console.log("Remaining stylesheets in map:", stylesheetUrlToId.size);
      console.log("=== END styleSheetRemoved ===");
    });

    cdp.on("CSS.styleSheetChanged", (event) => {
      console.log("=== CSS.styleSheetChanged ===");
      console.log("Changed styleSheetId:", event.styleSheetId);

      // Find the URL for this styleSheetId
      let changedUrl = null;
      for (const [url, id] of stylesheetUrlToId.entries()) {
        if (id === event.styleSheetId) {
          changedUrl = url;
          break;
        }
      }

      if (changedUrl) {
        console.log("Changed stylesheet URL:", changedUrl);
      } else {
        console.log("No URL mapping found for changed styleSheetId:", event.styleSheetId);
      }

      console.log("=== END styleSheetChanged ===");
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
        console.log(name, event);
      });
    };

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

    page.on("frameattached", (frame) => {
      //console.log('Frame attached:', frame.url());
    });

    // Use Playwright's route API for request interception
    await page.route("**/*", async (route: Route, request: Request) => {
      const url = request.url();
      console.log(url, targetUrl, url.startsWith(targetUrl));
      if (request.method() === "GET" && url.startsWith(targetUrl)) {
        console.log("request.method() === 'GET' && url.startsWith(targetUrl)");
        const urlObj = new URL(url);
        const urlNoSearch = urlObj.origin + urlObj.pathname;
        let fileName = path.join(dir, urlNoSearch.slice(targetUrl.length));

        console.log("fileName", fileName);

        const fileExist = await fs
          .access(fileName, fs.constants.F_OK)
          .then(() => true)
          .catch(() => false);
        const isDirectory =
          fileExist && (await fs.stat(fileName).then((stat) => stat.isDirectory()));
        if (isDirectory) {
          const indexfileName = path.join(fileName, "index.html");

          // check if file exists
          const indexFileExist = await fs
            .access(indexfileName, fs.constants.F_OK)
            .then(() => true)
            .catch(() => false);

          if (!indexFileExist) {
            console.log("serving directory listing", dir, fileName);

            await serveDirectoryListing(dir, route, fileName.slice(dir.length));
            return;
          }
          fileName = indexfileName;
        }

        if (!fileExist) {
          // TODO: use serve-handler to serve 404
          await serveDirectoryListing(dir, route, fileName.slice(dir.length));
          //   await route.fulfill({
          //     status: 404,
          //   });
          return;
        }

        const mimeType = mime.lookup(fileName);
        if (!mimeType) {
          await route.fulfill({
            status: 404,
          });
          return;
        }

        const body = await fs.readFile(fileName);
        await route.fulfill({
          body,
          status: 200,
          headers: {
            "Content-Type": mimeType,
            "Cache-Control": "max-age=0, must-revalidate, no-store",
          },
        });

        if (!watchers.has(url)) {
          if (patchers.has(mimeType)) {
            const watcher = chokidar.watch(fileName);
            const patcher = patchers.get(mimeType);
            if (patcher) {
              watcher.on("change", async () => {
                const newContent = await fs.readFile(fileName, "utf-8");
                await patcher(page, url, newContent, fileName);
                server.emit("patch", { fileName, url, mimeType });
              });
              server.emit("new-resource", { url, mimeType });
              watchers.set(url, watcher);
            }
          }
        }
      } else {
        await route.continue();
      }
    });

    await page.goto(targetUrl);
    return page;
  };

  return server;
}
