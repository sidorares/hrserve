import fs from "node:fs/promises";
import path from "node:path";
import mime from "mime-types";

export type ResolvedRequest =
  /** Request is not under the served base URL; let it through to the network. */
  | { kind: "pass" }
  /** Request tried to escape the served directory (or has malformed encoding). */
  | { kind: "forbidden" }
  /** File exists but its MIME type is unknown. */
  | { kind: "unknown-type"; filePath: string }
  /** Missing file or directory without index.html; `urlPath` is the raw URL path
   * (relative to the base URL) to hand to serve-handler for a listing / 404 page. */
  | { kind: "fallback"; urlPath: string }
  | { kind: "file"; filePath: string; mimeType: string };

/** Ensure the base URL ends with "/" so prefix matching can't cross a path segment
 * (e.g. base "http://host/app" must not match "http://host/apple"). */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

/**
 * Map a request URL onto the served directory.
 *
 * Matching compares origin and path segments via the URL parser rather than raw
 * string prefixes, so "http://localhost:3000" does not capture requests to
 * "http://localhost:30001" and query strings are ignored.
 */
export async function resolveRequest(
  dir: string,
  baseUrl: string,
  requestUrl: string
): Promise<ResolvedRequest> {
  let requested: URL;
  let base: URL;
  try {
    requested = new URL(requestUrl);
    base = new URL(normalizeBaseUrl(baseUrl));
  } catch {
    return { kind: "pass" };
  }

  const basePath = base.pathname; // always ends with "/"
  const withinBase =
    requested.pathname === basePath.slice(0, -1) || requested.pathname.startsWith(basePath);
  if (requested.origin !== base.origin || !withinBase) {
    return { kind: "pass" };
  }

  // Raw URL path relative to the base, with a leading "/" (what serve-handler expects).
  const urlPath = requested.pathname.slice(basePath.length - 1) || "/";

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(requested.pathname.slice(basePath.length));
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
    return { kind: "fallback", urlPath };
  }

  let finalPath = filePath;
  if (stat.isDirectory()) {
    const indexPath = path.join(filePath, "index.html");
    const indexStat = await fs.stat(indexPath).catch(() => null);
    if (!indexStat?.isFile()) {
      return { kind: "fallback", urlPath };
    }
    finalPath = indexPath;
  }

  const mimeType = mime.lookup(finalPath);
  if (!mimeType) {
    return { kind: "unknown-type", filePath: finalPath };
  }

  return { kind: "file", filePath: finalPath, mimeType };
}
