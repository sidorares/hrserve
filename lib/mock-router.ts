import path from "node:path";
import chokidar from "chokidar";
import { createJiti } from "jiti";
import { type MockRoute, type RouteMatch, matchRoute, scanRoutes } from "./mock-routes";
import { type WatchOptions, watchOptions } from "./watch-options";

/**
 * Executes file-based mock API routes in this process — no port, no spawned
 * server. Handlers follow Next.js conventions (see mock-routes.ts for the
 * matching rules) and are hot-reloaded when their file changes.
 */

export interface MockRequest {
  /** Absolute URL as the page requested it. */
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
}

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

type JitiInstance = ReturnType<typeof createJiti>;

export interface MockRouterOptions {
  dir: string;
  log?: (...args: unknown[]) => void;
  /** Write-settling policy, shared with the served-file watchers in serve(). */
  watch?: WatchOptions;
}

export class MockRouter {
  private readonly dir: string;
  private readonly log: (...args: unknown[]) => void;
  private readonly watch?: WatchOptions;
  private routes: MockRoute[] = [];
  private watcher?: chokidar.FSWatcher;
  /** Modules are cached so handlers can keep in-memory state (a todo list, a
   * counter) across requests; the cache is dropped when a file changes. */
  private jiti: JitiInstance;

  constructor(options: MockRouterOptions) {
    this.dir = path.resolve(options.dir);
    this.log = options.log ?? (() => {});
    this.watch = options.watch;
    this.jiti = createJiti(path.join(this.dir, "__hrserve_mock_entry__.js"), {
      interopDefault: true,
      moduleCache: true,
    });
  }

  async start(): Promise<void> {
    await this.rescan();

    // awaitWriteFinish, not chokidar's defaults: without it the 50ms leading-edge
    // throttle on `change` swallows the second of two back-to-back saves, and with
    // it the resetModules() call below — leaving the stale handler serving requests
    // until some later edit gets through. See watch-options.ts.
    const watcher = chokidar.watch(this.dir, {
      ignoreInitial: true,
      ...watchOptions(this.watch),
    });
    this.watcher = watcher;

    const onStructureChange = async (file: string) => {
      this.resetModules();
      await this.rescan();
      this.log("mock routes rescanned after change to", file);
    };
    watcher.on("add", onStructureChange);
    watcher.on("unlink", onStructureChange);
    watcher.on("change", (file) => {
      // Content change: drop cached modules so the next request re-imports them
      this.resetModules();
      this.log("mock handler reloaded:", file);
    });

    // Wait for the initial scan: chokidar ignores everything it sees before
    // "ready" (ignoreInitial), so edits made in that window would be lost.
    await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }

  private async rescan(): Promise<void> {
    this.routes = await scanRoutes(this.dir);
    this.log(`mock routes (${this.routes.length}):`, this.routes.map((r) => r.pattern).join(", "));
  }

  /**
   * jiti stores loaded modules in Node's global require.cache, so a fresh jiti
   * instance would still hand back the stale module — the cache entries have to
   * be purged by path. Everything under the mock directory goes, not just the
   * edited file, so a handler that imports a changed helper also reloads.
   */
  private resetModules(): void {
    if (typeof require === "undefined") return;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(this.dir + path.sep)) {
        delete require.cache[key];
      }
    }
  }

  get patterns(): string[] {
    return this.routes.map((route) => route.pattern);
  }

  /** Undefined means "no mock for this path" — the caller falls through to the next rule. */
  match(urlPath: string): RouteMatch | undefined {
    return matchRoute(this.routes, urlPath);
  }

  async handle(match: RouteMatch, request: MockRequest): Promise<MockResponse> {
    const module = (await this.jiti.import(match.route.filePath)) as Record<string, unknown>;
    return match.route.style === "app"
      ? await handleAppRoute(module, match, request)
      : await handlePagesRoute(module, match, request);
  }
}

/**
 * Next 15 made `params` a promise, Next 14 passed a plain object, and mock code
 * gets written both ways. This is awaitable *and* directly readable.
 */
function dualAccessParams(params: Record<string, string | string[]>) {
  return Object.assign(Promise.resolve(params), params);
}

function toMockResponse(response: Response, body: Buffer): MockResponse {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, body };
}

async function handleAppRoute(
  module: Record<string, unknown>,
  match: RouteMatch,
  request: MockRequest
): Promise<MockResponse> {
  const method = request.method.toUpperCase();
  const exported = HTTP_METHODS.filter((name) => typeof module[name] === "function");

  let handlerName: string | undefined = exported.find((name) => name === method);
  // Next serves HEAD from GET when HEAD isn't exported, dropping the body.
  const headViaGet = !handlerName && method === "HEAD" && exported.includes("GET");
  if (headViaGet) handlerName = "GET";

  if (!handlerName) {
    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: { allow: [...exported, "OPTIONS"].join(", ") },
        body: Buffer.alloc(0),
      };
    }
    return {
      status: 405,
      headers: { allow: exported.join(", "), "content-type": "text/plain" },
      body: Buffer.from(`hrserve mock: ${match.route.pattern} does not export ${method}`),
    };
  }

  const handler = module[handlerName] as (
    request: Request,
    context: { params: unknown }
  ) => Promise<Response> | Response;

  const init: RequestInit = { method, headers: request.headers };
  if (request.body?.length && method !== "GET" && method !== "HEAD") {
    init.body = new Uint8Array(request.body);
  }
  // A GET Request object is what the handler expects even when serving HEAD
  const webRequest = new Request(request.url, headViaGet ? { ...init, method: "GET" } : init);

  const response = await handler(webRequest, { params: dualAccessParams(match.params) });
  const body = headViaGet ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
  return toMockResponse(response, body);
}

/** Minimal NextApiRequest/NextApiResponse stand-ins for pages-style handlers. */
async function handlePagesRoute(
  module: Record<string, unknown>,
  match: RouteMatch,
  request: MockRequest
): Promise<MockResponse> {
  const handler = module.default;
  if (typeof handler !== "function") {
    return {
      status: 500,
      headers: { "content-type": "text/plain" },
      body: Buffer.from(`hrserve mock: ${match.route.filePath} has no default export`),
    };
  }

  const url = new URL(request.url);
  const query: Record<string, string | string[]> = { ...match.params };
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = value;
  }

  const req = {
    method: request.method.toUpperCase(),
    url: url.pathname + url.search,
    headers: request.headers,
    query,
    cookies: parseCookies(request.headers.cookie),
    body: parseBody(request.body, request.headers["content-type"]),
  };

  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(code: number) {
      statusCode = code;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      return res;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    removeHeader(name: string) {
      delete headers[name.toLowerCase()];
    },
    json(payload: unknown) {
      if (!headers["content-type"]) headers["content-type"] = "application/json; charset=utf-8";
      chunks.push(Buffer.from(JSON.stringify(payload)));
      settle();
      return res;
    },
    send(payload?: unknown) {
      if (payload !== undefined && payload !== null) {
        if (Buffer.isBuffer(payload)) {
          chunks.push(payload);
        } else if (typeof payload === "object") {
          if (!headers["content-type"]) headers["content-type"] = "application/json; charset=utf-8";
          chunks.push(Buffer.from(JSON.stringify(payload)));
        } else {
          if (!headers["content-type"]) headers["content-type"] = "text/html; charset=utf-8";
          chunks.push(Buffer.from(String(payload)));
        }
      }
      settle();
      return res;
    },
    redirect(codeOrUrl: number | string, maybeUrl?: string) {
      const [code, location] =
        typeof codeOrUrl === "number" ? [codeOrUrl, maybeUrl as string] : [307, codeOrUrl];
      statusCode = code;
      headers.location = location;
      settle();
      return res;
    },
    end(payload?: Buffer | string) {
      if (payload) chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
      settle();
      return res;
    },
    write(chunk: Buffer | string) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
  };

  const returned = handler(req, res);
  // Support both `res.json(...)` and handlers that only resolve their promise
  await Promise.race([finished, Promise.resolve(returned).then(() => finished)]);

  return { status: statusCode, headers, body: Buffer.concat(chunks) };
}

function parseCookies(header?: string): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    cookies[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return cookies;
}

/** Next parses JSON and urlencoded bodies before calling pages handlers. */
function parseBody(body: Buffer | undefined, contentType?: string): unknown {
  if (!body?.length) return undefined;
  const text = body.toString();
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return text;
}
