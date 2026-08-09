import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import chokidar from "chokidar";
import { validate } from "csstree-validator";
import type { Browser, CDPSession, Page, Request, Route } from "playwright";
import { MockRouter } from "./mock-router";
import { IMAGE_MIME_TYPES, reloadImage } from "./reload-image";
import {
  type ResolveConfig,
  type ResolvedRequest,
  normalizeBaseUrl,
  resolveRequest,
} from "./resolve-request";
import { type Rule, normalizeRules } from "./rules";
import { serveDirectoryListing } from "./serve-directory";

export type { Rule, ServeRule, UpstreamRule, ProxyRule, MockRule } from "./rules";

interface ServeOptions {
  url: string;
  /**
   * Directory to serve from. Optional when every rule carries its own `dir`.
   * With no `rules`, everything under `url` is served from here.
   */
  dir?: string;
  /**
   * Ordered routing rules, first match wins. Paths are matched relative to the
   * base `url` (e.g. "/api/**"). Requests matching no rule go to the network.
   */
  rules?: Rule[];
  width?: number;
  height?: number;
  /** Log request routing and CDP events. */
  verbose?: boolean;
  /**
   * Called once the page exists and request interception is installed, but
   * *before* the initial navigation — the only place to attach listeners that
   * must not miss the first load's console output and requests. May be async;
   * the returned value is awaited.
   */
  onPage?: (page: Page) => unknown;
  /**
   * @deprecated Has no effect: devtools can only be enabled when launching the
   * browser, e.g. `chromium.launch({ devtools: true })`.
   */
  devtools?: boolean;
}

/**
 * What actually happened to the page. `applied: false` means the change was
 * detected but not put into the page (invalid CSS, unknown stylesheet, a
 * browser without LiveEdit) — the distinction matters to anyone, human or
 * agent, asking "did my edit reach the page?".
 */
export interface PatchOutcome {
  applied: boolean;
  reason?: string;
}

interface PatchEvent extends PatchOutcome {
  fileName: string;
  url?: string;
  mimeType: string;
}

interface NewResourceEvent {
  url: string;
  mimeType: string;
}

/** How a single request was answered. */
export interface RequestEvent {
  url: string;
  method: string;
  kind: ResolvedRequest["kind"];
}

interface HRServer extends EventEmitter {
  serve(options: ServeOptions): Promise<Page>;
  /** Stop watching files. Does not close the browser (the caller owns it). */
  close(): Promise<void>;
  on(event: "patch", listener: (data: PatchEvent) => void): this;
  on(event: "new-resource", listener: (data: NewResourceEvent) => void): this;
  on(event: "request", listener: (data: RequestEvent) => void): this;
  emit(event: "patch", data: PatchEvent): boolean;
  emit(event: "new-resource", data: NewResourceEvent): boolean;
  emit(event: "request", data: RequestEvent): boolean;
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
) => Promise<PatchOutcome>;

interface ScriptDetails {
  scriptId: string;
  executionContextId?: number;
  url: string;
}

export function createServer(browser: Browser): HRServer {
  const server = new EventEmitter() as HRServer;
  const watchers = new Map<string, chokidar.FSWatcher>();
  const mockRouters: MockRouter[] = [];
  const patchers = new Map<string, PatcherFunction>();
  const scriptUrlToDetails = new Map<string, ScriptDetails>();
  const stylesheetUrlToId = new Map<string, string>();
  let log: (...args: unknown[]) => void = () => {};

  // Setup patchers for different MIME types
  patchers.set("text/css", async ({ cdp }, url, newContent, fileName) => {
    if (!newContent || !fileName) return { applied: false, reason: "empty-content" };

    const validationResult = validate(newContent, fileName);
    // TODO: config / cli option to allow patching invalid css
    if (validationResult.length) {
      console.warn("CSS validation failed:", validationResult);
      return {
        applied: false,
        reason: `css-invalid: ${validationResult[0]?.message ?? ""}`.trim(),
      };
    }
    const styleSheetId = stylesheetUrlToId.get(url);
    if (!styleSheetId) {
      log("no known stylesheet for", url);
      return { applied: false, reason: "stylesheet-not-loaded" };
    }
    try {
      await cdp.send("CSS.setStyleSheetText", {
        styleSheetId,
        text: newContent,
      });
      return { applied: true };
    } catch (e) {
      console.warn("Error setting stylesheet text", e);
      return { applied: false, reason: `cdp-error: ${(e as Error).message}` };
    }
  });

  for (const mimeType of IMAGE_MIME_TYPES) {
    patchers.set(mimeType, async ({ page }, url) => {
      const result = await reloadImage(page, url);
      return result.updatedCount > 0
        ? { applied: true }
        : { applied: false, reason: "no-references-to-image-on-page" };
    });
  }

  let liveEditUnavailableWarned = false;
  const patchScript: PatcherFunction = async ({ cdp }, url, scriptSource) => {
    if (!scriptSource) return { applied: false, reason: "empty-content" };

    let sourceSwapped = false;
    let reason = "";

    // Swapping the running source is best effort, but the script-patch event
    // below is a documented contract and must fire on every change — including
    // when Debugger.scriptParsed never told us about this URL (which happens
    // for scripts the debugger did not register, e.g. under load or when the
    // Debugger domain is unavailable).
    const scriptDetails = scriptUrlToDetails.get(url);
    if (!scriptDetails) {
      log("no known script for", url);
      reason = "script-not-registered-by-debugger";
    } else {
      try {
        const result = await cdp.send("Debugger.setScriptSource", {
          scriptId: scriptDetails.scriptId,
          scriptSource,
          allowTopFrameEditing: true,
        });
        sourceSwapped = result.status === "Ok";
        if (!sourceSwapped) {
          console.warn("Failed to patch script", result);
          reason = `live-edit-rejected: ${result.status}`;
        }
      } catch (e) {
        // Chromium removed LiveEdit (Debugger.setScriptSource) in Chrome 145:
        // https://developer.chrome.com/blog/devtools-deprecates-live-editing
        // The script-patch event below is the reliable way for pages to react.
        if (!liveEditUnavailableWarned) {
          liveEditUnavailableWarned = true;
          console.warn("Live script patching unavailable in this browser:", (e as Error).message);
        }
        reason = "live-edit-unavailable";
      }
    }

    // Let page code react to the change (e.g. re-run initialization).
    const detail = JSON.stringify({ detail: { scriptUrl: url } });
    await cdp.send("Runtime.evaluate", {
      expression: `window.dispatchEvent(new CustomEvent('script-patch', ${detail}))`,
    });

    // Without LiveEdit the page was told about the change but the running
    // script is unchanged; say so rather than claiming a successful patch.
    return sourceSwapped
      ? { applied: true }
      : { applied: false, reason: `${reason}; script-patch event dispatched` };
  };
  // mime-db has historically flip-flopped between the two names for .js
  patchers.set("application/javascript", patchScript);
  patchers.set("text/javascript", patchScript);

  patchers.set("text/html", async ({ cdp }, _url, newContent) => {
    if (!newContent) return { applied: false, reason: "empty-content" };

    const {
      root: { nodeId: rootNodeId },
    } = await cdp.send("DOM.getDocument");
    await cdp.send("DOM.setOuterHTML", {
      nodeId: rootNodeId,
      outerHTML: newContent,
    });
    return { applied: true };
  });

  // Main server functionality
  server.serve = async (options: ServeOptions): Promise<Page> => {
    const { url: targetUrl, dir, rules, width = 1280, height = 720, verbose = false } = options;
    if (verbose) {
      log = (...args: unknown[]) => console.log(...args);
    }

    const routeConfig: ResolveConfig = {
      baseUrl: normalizeBaseUrl(targetUrl),
      rules: normalizeRules(rules, dir),
    };

    // Mock rules need their route directory scanned (and watched) before serving
    for (const rule of routeConfig.rules) {
      if (rule.action !== "mock") continue;
      const router = new MockRouter({ dir: rule.dir as string, log });
      await router.start();
      rule.router = router;
      mockRouters.push(router);
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
      const url = request.url();
      const resolved = await resolveRequest(routeConfig, url, request.method());
      log("request", request.method(), url, "->", resolved.kind);
      server.emit("request", { url, method: request.method(), kind: resolved.kind });

      switch (resolved.kind) {
        case "pass":
          return route.continue();
        case "proxy": {
          // Fetch from Node rather than route.continue({ url }): continuing to
          // another origin makes the browser apply CORS to the response, which
          // defeats the point. Fetching here and fulfilling locally keeps the
          // response same-origin as far as the page is concerned.
          try {
            const response = await route.fetch({ url: resolved.target });
            return await route.fulfill({ response });
          } catch (e) {
            console.warn("Proxy request failed", resolved.target, e);
            return route.fulfill({ status: 502, body: "hrserve: proxy request failed" });
          }
        }
        case "mock": {
          try {
            const result = await resolved.router.handle(resolved.match, {
              url,
              method: request.method(),
              headers: await request.allHeaders(),
              body: request.postDataBuffer() ?? undefined,
            });
            return await route.fulfill({
              status: result.status,
              headers: result.headers,
              body: result.body,
            });
          } catch (e) {
            console.warn("Mock handler failed", resolved.match.route.filePath, e);
            return route.fulfill({
              status: 500,
              headers: { "content-type": "text/plain" },
              body: `hrserve mock handler failed: ${(e as Error).message}`,
            });
          }
        }
        case "forbidden":
        case "unknown-type":
          return route.fulfill({ status: 404 });
        case "fallback":
          // serve-handler renders the directory listing / 404 page
          return serveDirectoryListing(resolved.dir, route, resolved.urlPath);
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
                const outcome = await patcher({ page, cdp }, url, newContent, filePath);
                server.emit("patch", {
                  fileName: filePath,
                  url,
                  mimeType,
                  applied: outcome.applied,
                  reason: outcome.reason,
                });
              } catch (e) {
                console.warn("Failed to patch", filePath, e);
                server.emit("patch", {
                  fileName: filePath,
                  url,
                  mimeType,
                  applied: false,
                  reason: `error: ${(e as Error).message}`,
                });
              }
            });
            watchers.set(url, watcher);
            // The response is already fulfilled, so waiting here costs the page
            // nothing — but chokidar ignores anything that changes before it is
            // ready, so without this an edit made moments after load is lost.
            await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
            server.emit("new-resource", { url, mimeType });
          }
          return;
        }
      }
    });

    await options.onPage?.(page);

    await page.goto(targetUrl);
    return page;
  };

  server.close = async () => {
    const closing = [...watchers.values()].map((watcher) => watcher.close());
    watchers.clear();
    closing.push(...mockRouters.splice(0).map((router) => router.close()));
    await Promise.all(closing);
  };

  return server;
}
