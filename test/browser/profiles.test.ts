import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type Browser, type Page, chromium } from "playwright";
import { createServer } from "../../lib/hrserve";

let browser: Browser;
let profilesDir: string;
let siteDir: string;

/** Reads and writes the state a login would leave behind. */
const readState = () =>
  ({
    localStorage: window.localStorage.getItem("token"),
    cookie: document.cookie,
  }) as { localStorage: string | null; cookie: string };

async function serveWith(profile?: string) {
  const server = createServer(browser, { profilesDir });
  const page = await server.serve({ url: "http://profiles.hrserve.test/", dir: siteDir, profile });
  return { server, page };
}

/** Start a session, run something in it, save the result as a new profile. */
async function branch(from: string | undefined, as: string, work?: (page: Page) => Promise<void>) {
  const { server, page } = await serveWith(from);
  try {
    await work?.(page);
    return await server.saveProfile(as);
  } finally {
    await page.context().close();
    await server.close();
  }
}

before(async () => {
  browser = await chromium.launch({ headless: true });
  profilesDir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-profdir-"));
  siteDir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-profsite-"));
  await fs.writeFile(
    path.join(siteDir, "index.html"),
    "<!DOCTYPE html><html><body><h1>profiles</h1></body></html>"
  );
});

after(async () => {
  await browser.close();
  await fs.rm(profilesDir, { recursive: true, force: true });
  await fs.rm(siteDir, { recursive: true, force: true });
});

describe("session profiles", () => {
  it("starts fresh when no profile is given", async () => {
    const { server, page } = await serveWith();
    try {
      const state = await page.evaluate(readState);
      assert.equal(state.localStorage, null);
      assert.equal(state.cookie, "");
    } finally {
      await page.context().close();
      await server.close();
    }
  });

  it("restores cookies and storage saved from an earlier session", async () => {
    // Session A: stand in for the manual login
    const saved = await branch(undefined, "A", async (page) => {
      await page.evaluate(() => {
        window.localStorage.setItem("token", "from-A");
        document.cookie = "session=aaa; path=/";
      });
    });
    assert.deepEqual(saved.origins, ["http://profiles.hrserve.test"]);
    assert.equal(saved.parent, undefined);

    // A later session started from A sees that state
    const { server, page } = await serveWith("A");
    try {
      const state = await page.evaluate(readState);
      assert.equal(state.localStorage, "from-A");
      assert.match(state.cookie, /session=aaa/);
    } finally {
      await page.context().close();
      await server.close();
    }
  });

  it("branches A -> B, A -> C, C -> D without the branches affecting each other", async () => {
    // B and C both start from A; only C adds something and is saved as its own profile
    const { server: serverB, page: pageB } = await serveWith("A");
    const { server: serverC, page: pageC } = await serveWith("A");
    try {
      // Both branches see A's state, at the same time
      assert.equal((await pageB.evaluate(readState)).localStorage, "from-A");
      assert.equal((await pageC.evaluate(readState)).localStorage, "from-A");

      await pageC.evaluate(() => window.localStorage.setItem("extra", "from-C"));
      const savedC = await serverC.saveProfile("C");
      assert.equal(savedC.parent, "A", "lineage is recorded from the profile it started from");

      // B is untouched by what happened in C
      assert.equal(await pageB.evaluate(() => window.localStorage.getItem("extra")), null);
    } finally {
      await pageB.context().close();
      await pageC.context().close();
      await serverB.close();
      await serverC.close();
    }

    // D starts from C and inherits both A's and C's state
    const { server: serverD, page: pageD } = await serveWith("C");
    try {
      const state = await pageD.evaluate(() => ({
        token: window.localStorage.getItem("token"),
        extra: window.localStorage.getItem("extra"),
      }));
      assert.deepEqual(state, { token: "from-A", extra: "from-C" });
    } finally {
      await pageD.context().close();
      await serverD.close();
    }

    // ...and A itself never changed, so starting from it is still reproducible
    const { server: serverA2, page: pageA2 } = await serveWith("A");
    try {
      assert.equal(await pageA2.evaluate(() => window.localStorage.getItem("extra")), null);
    } finally {
      await pageA2.context().close();
      await serverA2.close();
    }
  });

  it("does not write back to the profile a session started from", async () => {
    const before = await fs.readFile(path.join(profilesDir, "A.json"), "utf-8");
    const { server, page } = await serveWith("A");
    try {
      await page.evaluate(() => window.localStorage.setItem("token", "changed-in-session"));
    } finally {
      await page.context().close();
      await server.close();
    }
    assert.equal(await fs.readFile(path.join(profilesDir, "A.json"), "utf-8"), before);
  });

  it("warns instead of silently serving logged-out when the profile does not cover the URL", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    const server = createServer(browser, { profilesDir });
    let page: Page | undefined;
    try {
      page = await server.serve({
        url: "http://different-origin.hrserve.test/",
        dir: siteDir,
        profile: "A",
      });
      assert.ok(
        warnings.some((warning) => warning.includes("does not cover")),
        `expected a coverage warning, got: ${JSON.stringify(warnings)}`
      );
    } finally {
      console.warn = original;
      await page?.context().close();
      await server.close();
    }
  });

  it("fails clearly when the profile does not exist", async () => {
    const server = createServer(browser, { profilesDir });
    await assert.rejects(
      () => server.serve({ url: "http://profiles.hrserve.test/", dir: siteDir, profile: "ghost" }),
      /No profile named "ghost"/
    );
    await server.close();
  });

  it("refuses to save before a session exists", async () => {
    const server = createServer(browser, { profilesDir });
    await assert.rejects(() => server.saveProfile("nope"), /needs a running session/);
    await server.close();
  });
});
