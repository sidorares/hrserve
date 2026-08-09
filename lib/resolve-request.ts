import fs from "node:fs/promises";
import path from "node:path";
import mime from "mime-types";
import type { MockRouter } from "./mock-router";
import type { RouteMatch } from "./mock-routes";
import { type NormalizedRule, buildProxyTarget, ruleApplies } from "./rules";

export type ResolvedRequest =
  /** Not ours (outside the base URL, or no rule matched): let it hit the network. */
  | { kind: "pass" }
  /** Send the request to another origin with a rewritten URL. */
  | { kind: "proxy"; target: string }
  /** Answer from an in-process mock API route. */
  | { kind: "mock"; router: MockRouter; match: RouteMatch }
  /** Request tried to escape the served directory (or has malformed encoding). */
  | { kind: "forbidden" }
  /** File exists but its MIME type is unknown. */
  | { kind: "unknown-type"; filePath: string }
  /** Missing file or directory without index.html; `urlPath` is the raw URL path
   * (relative to the base URL) to hand to serve-handler for a listing / 404 page. */
  | { kind: "fallback"; urlPath: string; dir: string }
  | { kind: "file"; filePath: string; mimeType: string };

export interface ResolveConfig {
  /** Base URL, normalized to end with "/". */
  baseUrl: string;
  rules: NormalizedRule[];
}

/** Ensure the base URL ends with "/" so prefix matching can't cross a path segment
 * (e.g. base "http://host/app" must not match "http://host/apple"). */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

/** Methods for which serving a file from disk makes sense. */
const FILE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Map a request URL onto a routing decision.
 *
 * Matching compares origin and path segments via the URL parser rather than raw
 * string prefixes, so "http://localhost:3000" does not capture requests to
 * "http://localhost:30001" and query strings are ignored.
 */
export async function resolveRequest(
  config: ResolveConfig,
  requestUrl: string,
  method = "GET"
): Promise<ResolvedRequest> {
  let requested: URL;
  let base: URL;
  try {
    requested = new URL(requestUrl);
    base = new URL(normalizeBaseUrl(config.baseUrl));
  } catch {
    return { kind: "pass" };
  }

  const basePath = base.pathname; // always ends with "/"
  const withinBase =
    requested.pathname === basePath.slice(0, -1) || requested.pathname.startsWith(basePath);
  if (requested.origin !== base.origin || !withinBase) {
    return { kind: "pass" };
  }

  // Raw URL path relative to the base, with a leading "/" (what rules match against
  // and what serve-handler expects).
  const urlPath = requested.pathname.slice(basePath.length - 1) || "/";

  // First applicable rule wins, except that a mock rule with no matching route
  // falls through to the next rule (so "mock what exists, proxy the rest" works).
  for (const rule of config.rules) {
    if (!ruleApplies(rule, urlPath, method)) continue;

    switch (rule.action) {
      case "upstream":
        return { kind: "pass" };

      case "proxy":
        return {
          kind: "proxy",
          target: buildProxyTarget(rule.target as string, urlPath, requested.search),
        };

      case "mock": {
        const router = rule.router as MockRouter | undefined;
        const match = router?.match(urlPath);
        if (!match) continue;
        return { kind: "mock", router: router as MockRouter, match };
      }

      default:
        return resolveFile(rule, urlPath, method);
    }
  }

  return { kind: "pass" };
}

async function resolveFile(
  rule: NormalizedRule,
  urlPath: string,
  method: string
): Promise<ResolvedRequest> {
  if (!FILE_METHODS.has(method.toUpperCase())) {
    return { kind: "pass" };
  }
  const dir = rule.dir as string;

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(urlPath.slice(1));
  } catch {
    return { kind: "forbidden" };
  }

  const filePath = path.join(dir, relativePath);

  // Percent-encoded ".." survives URL normalization; keep resolution inside `dir`.
  const root = path.resolve(dir);
  const resolved = path.resolve(filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { kind: "forbidden" };
  }

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    return { kind: "fallback", urlPath, dir };
  }

  let finalPath = filePath;
  if (stat.isDirectory()) {
    const indexPath = path.join(filePath, "index.html");
    const indexStat = await fs.stat(indexPath).catch(() => null);
    if (!indexStat?.isFile()) {
      return { kind: "fallback", urlPath, dir };
    }
    finalPath = indexPath;
  }

  const mimeType = mime.lookup(finalPath);
  if (!mimeType) {
    return { kind: "unknown-type", filePath: finalPath };
  }

  return { kind: "file", filePath: finalPath, mimeType };
}
