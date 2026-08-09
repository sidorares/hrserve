import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HOT_UPDATE_PARAM,
  buildHotUpdateUrl,
  hotUpdateExpression,
  isHotUpdateUrl,
  resolveHotUpdateMode,
} from "../../lib/patch-script";

describe("resolveHotUpdateMode", () => {
  it('picks the mechanism from isModule when "auto"', () => {
    assert.equal(resolveHotUpdateMode("auto", false), "evaluate");
    assert.equal(resolveHotUpdateMode("auto", true), "import");
  });

  it("only notifies when the browser never reported the script", () => {
    // Guessing here means either "Cannot use import statement outside a module"
    // or a module evaluated in global scope.
    assert.equal(resolveHotUpdateMode("auto", undefined), "none");
  });

  it("honours an explicit mechanism regardless of how the file was parsed", () => {
    assert.equal(resolveHotUpdateMode("evaluate", true), "evaluate");
    assert.equal(resolveHotUpdateMode("import", false), "import");
  });

  it('never runs new source when "off"', () => {
    assert.equal(resolveHotUpdateMode("off", false), "none");
    assert.equal(resolveHotUpdateMode("off", true), "none");
    assert.equal(resolveHotUpdateMode("off", undefined), "none");
  });
});

describe("hot update URLs", () => {
  it("adds the version parameter", () => {
    const url = buildHotUpdateUrl("http://app.test/app.js", 1);
    assert.equal(url, `http://app.test/app.js?${HOT_UPDATE_PARAM}=1`);
    assert.ok(isHotUpdateUrl(url));
  });

  it("keeps an existing query string", () => {
    const url = buildHotUpdateUrl("http://app.test/app.js?lang=en", 2);
    assert.equal(new URL(url).searchParams.get("lang"), "en");
    assert.equal(new URL(url).searchParams.get(HOT_UPDATE_PARAM), "2");
  });

  it("replaces the version instead of stacking versions", () => {
    const once = buildHotUpdateUrl("http://app.test/app.js", 1);
    const twice = buildHotUpdateUrl(once, 2);
    assert.equal(twice, `http://app.test/app.js?${HOT_UPDATE_PARAM}=2`);
  });

  it("does not mistake page URLs for hrserve's own requests", () => {
    assert.equal(isHotUpdateUrl("http://app.test/app.js"), false);
    assert.equal(isHotUpdateUrl("http://app.test/app.js?v=1"), false);
    // Debugger.scriptParsed reports "" for inline and eval'd scripts
    assert.equal(isHotUpdateUrl(""), false);
    assert.equal(isHotUpdateUrl("not a url"), false);
  });
});

describe("hotUpdateExpression", () => {
  const build = (mode: "evaluate" | "import" | "none", source = "window.x = 1;") =>
    hotUpdateExpression({ url: "http://app.test/app.js", mode, source, version: 7 });

  /** Compiles the expression without running it: catches string-building bugs. */
  const assertCompiles = (expression: string) => {
    assert.doesNotThrow(() => new Function(expression), `should compile:\n${expression}`);
  };

  it("produces syntactically valid JavaScript in every mode", () => {
    assertCompiles(build("evaluate"));
    assertCompiles(build("import"));
    assertCompiles(build("none"));
  });

  it("survives source that would break naive string interpolation", () => {
    const nasty = [
      'const quote = "it\'s `tricky`";',
      "const template = `${quote} ${'}'}`;",
      "// a trailing line comment without a newline",
    ].join("\n");
    assertCompiles(build("evaluate", nasty));
    assert.ok(
      build("evaluate", nasty).includes(JSON.stringify(`${nasty}\n//# sourceURL=`).slice(1, -1))
    );
  });

  it("dispatches script-patch in every mode, including when nothing will run", () => {
    for (const mode of ["evaluate", "import", "none"] as const) {
      assert.match(build(mode), /new CustomEvent\("script-patch"/);
      assert.match(build(mode), /cancelable: true/);
    }
  });

  it("re-runs classic scripts with indirect eval and a sourceURL", () => {
    const expression = build("evaluate");
    // Direct `Runtime.evaluate` of the source would throw "Identifier has
    // already been declared" for any top-level const/let.
    assert.match(expression, /\(0, eval\)\(/);
    assert.match(expression, /sourceURL=http:\/\/app\.test\/app\.js/);
    assert.doesNotMatch(expression, /await import\(/);
  });

  it("re-imports modules under a cache-busted URL", () => {
    const expression = build("import");
    assert.ok(expression.includes(JSON.stringify(buildHotUpdateUrl("http://app.test/app.js", 7))));
    assert.doesNotMatch(expression, /\(0, eval\)\(/);
  });

  it("embeds no source at all when nothing will run", () => {
    const expression = build("none", "window.SHOULD_NOT_APPEAR = 1;");
    assert.doesNotMatch(expression, /SHOULD_NOT_APPEAR/);
    assert.match(expression, /"skipped"/);
  });
});
