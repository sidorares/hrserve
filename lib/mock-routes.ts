import fs from "node:fs/promises";
import path from "node:path";

/**
 * File-system route discovery and matching following Next.js conventions.
 *
 * This module is pure path handling — no module loading, no execution — so the
 * matching rules (which are subtle) can be unit-tested on their own.
 */

export const ROUTE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** App Router files that are UI/infrastructure, never request handlers. */
const APP_SPECIAL_FILES = new Set([
  "page",
  "layout",
  "template",
  "loading",
  "error",
  "not-found",
  "default",
  "global-error",
  "middleware",
  "instrumentation",
]);

const IGNORED_DIRS = new Set(["node_modules", "__tests__"]);

export type Segment =
  | { kind: "static"; value: string }
  | { kind: "dynamic"; name: string }
  | { kind: "catchAll"; name: string }
  | { kind: "optionalCatchAll"; name: string };

export type RouteStyle = "app" | "pages";

export interface MockRoute {
  /** Absolute path of the handler module. */
  filePath: string;
  /** "app" = route.ts exporting GET/POST…; "pages" = default (req, res) handler. */
  style: RouteStyle;
  segments: Segment[];
  /** Human-readable pattern for logs and errors, e.g. "/api/users/[id]". */
  pattern: string;
}

export type RouteParams = Record<string, string | string[]>;

export interface RouteMatch {
  route: MockRoute;
  params: RouteParams;
}

/** Route groups `(marketing)` and parallel routes `@modal` don't affect the URL. */
function isTransparentSegment(name: string): boolean {
  return (name.startsWith("(") && name.endsWith(")")) || name.startsWith("@");
}

export function parseSegment(raw: string): Segment {
  const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(raw);
  if (optionalCatchAll) {
    return { kind: "optionalCatchAll", name: optionalCatchAll[1] };
  }
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(raw);
  if (catchAll) {
    return { kind: "catchAll", name: catchAll[1] };
  }
  const dynamic = /^\[(.+)\]$/.exec(raw);
  if (dynamic) {
    return { kind: "dynamic", name: dynamic[1] };
  }
  return { kind: "static", value: raw };
}

function segmentRank(segment: Segment): number {
  switch (segment.kind) {
    case "static":
      return 0;
    case "dynamic":
      return 1;
    case "catchAll":
      return 2;
    default:
      return 3;
  }
}

function formatSegment(segment: Segment): string {
  switch (segment.kind) {
    case "static":
      return segment.value;
    case "dynamic":
      return `[${segment.name}]`;
    case "catchAll":
      return `[...${segment.name}]`;
    default:
      return `[[...${segment.name}]]`;
  }
}

/**
 * Next's resolution priority: more specific wins. Static beats dynamic beats
 * catch-all beats optional catch-all, decided at the first differing segment.
 */
export function compareRoutes(a: MockRoute, b: MockRoute): number {
  const shared = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < shared; i++) {
    const diff = segmentRank(a.segments[i]) - segmentRank(b.segments[i]);
    if (diff !== 0) return diff;
  }
  // Same shape so far: the longer (more specific) route goes first.
  return b.segments.length - a.segments.length;
}

/** Turn a path relative to the mock root into route segments. */
function segmentsFromRelativePath(relativeDir: string): Segment[] {
  return relativeDir
    .split(path.sep)
    .filter((part) => part && part !== "." && !isTransparentSegment(part))
    .map(parseSegment);
}

/**
 * Recursively find handler files under `root`.
 *
 * - a file named `route.*` is an App Router handler; its URL is the directory it sits in
 * - any other file is a Pages Router handler; its URL is the file path minus extension
 *   (`index` meaning the directory itself), skipping App Router special files
 *   (`page`, `layout`, …) and `_`-prefixed files
 */
export async function scanRoutes(root: string): Promise<MockRoute[]> {
  const routes: MockRoute[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name);
      if (!ROUTE_EXTENSIONS.includes(ext)) continue;
      if (entry.name.endsWith(".d.ts")) continue;

      const base = path.basename(entry.name, ext);
      if (base.startsWith("_") || base.startsWith(".")) continue;

      const relativeDir = path.relative(root, dir);
      if (base === "route") {
        const segments = segmentsFromRelativePath(relativeDir);
        routes.push({
          filePath: full,
          style: "app",
          segments,
          pattern: `/${segments.map(formatSegment).join("/")}`,
        });
        continue;
      }
      if (APP_SPECIAL_FILES.has(base)) continue;

      const segments = segmentsFromRelativePath(relativeDir);
      if (base !== "index") {
        segments.push(parseSegment(base));
      }
      routes.push({
        filePath: full,
        style: "pages",
        segments,
        pattern: `/${segments.map(formatSegment).join("/")}`,
      });
    }
  }

  await walk(root);
  return routes.sort(compareRoutes);
}

/** Split a URL path into decoded segments. Returns null on malformed encoding. */
function splitPath(urlPath: string): string[] | null {
  const parts = urlPath.split("/").filter(Boolean);
  try {
    return parts.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

function matchSegments(segments: Segment[], parts: string[]): RouteParams | null {
  const params: RouteParams = {};
  let index = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;

    switch (segment.kind) {
      case "static":
        if (parts[index] !== segment.value) return null;
        index++;
        break;
      case "dynamic":
        if (index >= parts.length) return null;
        params[segment.name] = parts[index];
        index++;
        break;
      case "catchAll": {
        // Must be the final segment and consume at least one part
        if (!isLast || index >= parts.length) return null;
        params[segment.name] = parts.slice(index);
        index = parts.length;
        break;
      }
      default: {
        if (!isLast) return null;
        params[segment.name] = parts.slice(index);
        index = parts.length;
        break;
      }
    }
  }

  return index === parts.length ? params : null;
}

/** First matching route wins; `routes` must already be sorted by compareRoutes. */
export function matchRoute(routes: MockRoute[], urlPath: string): RouteMatch | undefined {
  const parts = splitPath(urlPath);
  if (!parts) return undefined;

  for (const route of routes) {
    const params = matchSegments(route.segments, parts);
    if (params) return { route, params };
  }
  return undefined;
}
