/**
 * JavaScript hot-update strategy.
 *
 * Chromium removed LiveEdit (`Debugger.setScriptSource`) in Chrome 145
 * (https://developer.chrome.com/blog/devtools-deprecates-live-editing), so a
 * running script's body can no longer be swapped in place. What is left is
 * classic HMR: run the new source again and let the page clean up after the old
 * one. How that is done depends on how the browser parsed the file:
 *
 * - classic script -> indirect `eval` of the new source in global scope
 * - ES module      -> dynamic `import()` of a cache-busted URL
 *
 * Both re-run top-level side effects, so the `script-patch` event is dispatched
 * *before* the new source runs, giving page code a chance to dispose of the old
 * one (and to cancel or take over the update entirely).
 */

/**
 * Query parameter hrserve appends to its own re-import requests. The ES module
 * map is keyed by URL and is not an HTTP cache, so a changed module can only be
 * re-executed under a URL it has not been imported under before. Requests
 * carrying this parameter are hrserve's own and must not spawn extra watchers.
 */
export const HOT_UPDATE_PARAM = "__hrserve_v";

/** How `serve()` should handle changed JavaScript files. */
export type ScriptReloadMode =
  /** Re-run classic scripts, re-import ES modules (the default). */
  | "auto"
  /** Always re-run the source with indirect eval, whatever the browser parsed it as. */
  | "evaluate"
  /** Always re-import a cache-busted URL. */
  | "import"
  /** Only dispatch `script-patch`; never run the new source. */
  | "off";

/** What the patcher will actually do for one particular script. */
export type HotUpdateMode = "evaluate" | "import" | "none";

export interface HotUpdateResult {
  /**
   * - `applied`   — the new source ran
   * - `cancelled` — a `script-patch` listener called `preventDefault()`
   * - `skipped`   — nothing to run (mode `none`)
   * - `failed`    — the new source, or an `accept` handler, threw
   */
  status: "applied" | "cancelled" | "skipped" | "failed";
  message?: string;
}

/** Is this one of hrserve's own cache-busted re-import requests? */
export function isHotUpdateUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.has(HOT_UPDATE_PARAM);
  } catch {
    // Debugger.scriptParsed reports "" for inline and eval'd scripts.
    return false;
  }
}

export function buildHotUpdateUrl(url: string, version: number): string {
  const busted = new URL(url);
  busted.searchParams.set(HOT_UPDATE_PARAM, String(version));
  return busted.toString();
}

/**
 * Pick the mechanism for one script. `isModule` comes from
 * `Debugger.scriptParsed`; it is undefined for files the page fetched but never
 * executed as a script (a worker entry point, say), and guessing wrong there
 * means either a syntax error or a module evaluated in global scope, so such
 * files are only announced via the event.
 */
export function resolveHotUpdateMode(
  configured: ScriptReloadMode,
  isModule?: boolean
): HotUpdateMode {
  if (configured === "off") return "none";
  if (configured === "evaluate" || configured === "import") return configured;
  if (isModule === undefined) return "none";
  return isModule ? "import" : "evaluate";
}

/**
 * Build the expression run via `Runtime.evaluate` to apply one update.
 *
 * Everything happens inside the page in one step — dispose, re-run, hand the
 * result to `accept` callbacks — so page code never observes a state where the
 * old script has been torn down but the new one has not run yet.
 */
export function hotUpdateExpression(options: {
  url: string;
  mode: HotUpdateMode;
  source: string;
  version: number;
}): string {
  const { url, mode, source, version } = options;

  let apply: string;
  if (mode === "import") {
    apply = `await import(${JSON.stringify(buildHotUpdateUrl(url, version))})`;
  } else {
    // Indirect eval, deliberately: like a classic script it runs in global scope
    // (so `var` and function declarations stay global) but unlike a re-added
    // <script> tag it gets its own lexical environment, so a top-level `const`
    // does not collide with the binding the first run already created. A direct
    // `Runtime.evaluate` of the source fails with "Identifier 'x' has already
    // been declared" for any file with a top-level const/let/class.
    // `//# sourceURL` keeps devtools and stack traces on the real file.
    apply = `(0, eval)(${JSON.stringify(`${source}\n//# sourceURL=${url}`)})`;
  }

  const applyBlock =
    mode === "none"
      ? '  return { status: "skipped" };'
      : `  try {
    const exports = ${apply};
    for (const handler of accepted) await handler(exports);
    return { status: "applied" };
  } catch (error) {
    const message = (error && error.message) || String(error);
    window.dispatchEvent(
      new CustomEvent("script-patch-error", { detail: { scriptUrl, message } })
    );
    return { status: "failed", message };
  }`;

  return `(async () => {
  const scriptUrl = ${JSON.stringify(url)};
  const accepted = [];
  const detail = {
    scriptUrl,
    mode: ${JSON.stringify(mode)},
    accept(handler) {
      if (typeof handler === "function") accepted.push(handler);
    },
  };
  const proceed = window.dispatchEvent(
    new CustomEvent("script-patch", { detail, cancelable: true })
  );
  if (!proceed) return { status: "cancelled" };
${applyBlock}
})()`;
}
