import picomatch from "picomatch";

/** Serve the request from a local directory (the default hrserve behaviour). */
export interface ServeRule {
  /** Glob matched against the request path relative to the base URL, e.g. "/assets/**". Defaults to "**". */
  match?: string;
  /** HTTP methods this rule applies to. Defaults to every method. */
  methods?: string[];
  action: "serve";
  /** Directory to serve from. Defaults to the top-level `dir` passed to serve(). */
  dir?: string;
}

/** Let the request go to the network untouched. */
export interface UpstreamRule {
  match?: string;
  methods?: string[];
  action: "upstream";
}

/**
 * Send the request to a different origin. Unlike `upstream`, the URL is
 * rewritten, so the page can talk to another backend without CORS: as far as
 * the page is concerned the request never left its own origin.
 */
export interface ProxyRule {
  match?: string;
  methods?: string[];
  action: "proxy";
  /** Target origin, optionally with a path prefix, e.g. "https://staging.example.com/v2". */
  target: string;
}

export type Rule = ServeRule | UpstreamRule | ProxyRule;

export interface NormalizedRule {
  match: string;
  methods?: string[];
  action: Rule["action"];
  dir?: string;
  target?: string;
  isMatch(urlPath: string): boolean;
}

/**
 * Turn the user-facing rule list into matchers, filling in defaults.
 *
 * With no rules, hrserve behaves as it always has: everything under the base
 * URL is served from `defaultDir`.
 */
export function normalizeRules(rules: Rule[] | undefined, defaultDir?: string): NormalizedRule[] {
  const source: Rule[] = rules?.length ? rules : [{ action: "serve" }];

  return source.map((rule, index) => {
    const match = rule.match ?? "**";
    const dir = rule.action === "serve" ? (rule.dir ?? defaultDir) : undefined;

    if (rule.action === "serve" && !dir) {
      throw new Error(
        `Rule ${index} ("${match}") has action "serve" but no directory: ` +
          "set `dir` on the rule or pass `dir` to serve()."
      );
    }
    if (rule.action === "proxy") {
      // Fail loudly at setup instead of on the first matching request.
      try {
        new URL(rule.target);
      } catch {
        throw new Error(`Rule ${index} ("${match}") has an invalid proxy target: "${rule.target}"`);
      }
    }

    const isMatch = picomatch(match, { dot: true });
    return {
      match,
      methods: rule.methods?.map((method) => method.toUpperCase()),
      action: rule.action,
      dir,
      target: rule.action === "proxy" ? rule.target : undefined,
      isMatch: (urlPath: string) => isMatch(urlPath),
    };
  });
}

/** Find the first rule matching this path and method; undefined means "not ours". */
export function matchRule(
  rules: NormalizedRule[],
  urlPath: string,
  method: string
): NormalizedRule | undefined {
  const upperMethod = method.toUpperCase();
  return rules.find(
    (rule) => (!rule.methods || rule.methods.includes(upperMethod)) && rule.isMatch(urlPath)
  );
}

/**
 * Build the proxied URL: the request path (relative to the base URL) and query
 * string are appended to the target, preserving any path prefix on the target.
 * "https://api.example.com/v2" + "/users?q=1" -> "https://api.example.com/v2/users?q=1"
 */
export function buildProxyTarget(target: string, relativePath: string, search: string): string {
  const targetUrl = new URL(target);
  const prefix = targetUrl.pathname.replace(/\/$/, "");
  targetUrl.pathname = `${prefix}${relativePath}`;
  targetUrl.search = search;
  return targetUrl.toString();
}
