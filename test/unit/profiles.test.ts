import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  ProfileStore,
  type StorageState,
  assertValidProfileName,
  defaultProfilesDir,
  profileCoversUrl,
} from "../../lib/profiles";

function stateWith(options: {
  origins?: string[];
  cookieDomains?: string[];
  localStorage?: Record<string, string>;
}): StorageState {
  return {
    cookies: (options.cookieDomains ?? []).map((domain) => ({
      name: "session",
      value: "abc",
      domain,
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    })),
    origins: (options.origins ?? []).map((origin) => ({
      origin,
      localStorage: Object.entries(options.localStorage ?? { token: "t" }).map(([name, value]) => ({
        name,
        value,
      })),
    })),
  };
}

describe("assertValidProfileName", () => {
  it("accepts ordinary names", () => {
    for (const name of ["A", "prod-login", "team_2", "a.b"]) {
      assert.doesNotThrow(() => assertValidProfileName(name));
    }
  });

  it("rejects names that could escape the profiles directory", () => {
    for (const name of ["../etc/passwd", "a/b", "..", ".hidden", "", "a".repeat(65)]) {
      assert.throws(() => assertValidProfileName(name), /Invalid profile name/);
    }
  });
});

describe("defaultProfilesDir", () => {
  it("keeps profiles out of the working tree", () => {
    const dir = defaultProfilesDir();
    assert.ok(path.isAbsolute(dir));
    assert.match(dir, /hrserve[/\\]profiles$/);
    assert.ok(
      !dir.startsWith(process.cwd() + path.sep),
      "profiles hold session cookies and must not live inside the repo"
    );
  });
});

describe("profileCoversUrl", () => {
  it("matches an exact origin", () => {
    const profile = { origins: ["https://app.example.com"], cookieDomains: [] };
    assert.equal(profileCoversUrl(profile, "https://app.example.com/dashboard"), true);
    assert.equal(profileCoversUrl(profile, "https://other.example.com/"), false);
  });

  it("does not treat a different scheme or port as the same origin", () => {
    const profile = { origins: ["https://app.example.com"], cookieDomains: [] };
    assert.equal(profileCoversUrl(profile, "http://app.example.com/"), false);
    assert.equal(profileCoversUrl(profile, "https://app.example.com:8443/"), false);
  });

  it("matches subdomains through a dotted cookie domain", () => {
    const profile = { origins: [], cookieDomains: [".example.com"] };
    assert.equal(profileCoversUrl(profile, "https://app.example.com/"), true);
    assert.equal(profileCoversUrl(profile, "https://example.com/"), true);
    assert.equal(profileCoversUrl(profile, "https://example.com.evil.test/"), false);
  });

  it("reports no coverage for a fake origin, which is the common mistake", () => {
    const profile = { origins: ["https://app.example.com"], cookieDomains: [".example.com"] };
    assert.equal(profileCoversUrl(profile, "http://app.hrserve.test/"), false);
  });

  it("treats an unparseable url as uncovered instead of throwing", () => {
    assert.equal(profileCoversUrl({ origins: [], cookieDomains: [] }, "not a url"), false);
  });
});

describe("ProfileStore", () => {
  let dir: string;
  let store: ProfileStore;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-profiles-"));
    store = new ProfileStore(dir);
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips a profile", async () => {
    const state = stateWith({
      origins: ["https://app.example.com"],
      cookieDomains: [".example.com"],
      localStorage: { token: "secret" },
    });
    const summary = await store.save("A", { storageState: state });

    assert.equal(summary.name, "A");
    assert.deepEqual(summary.origins, ["https://app.example.com"]);
    assert.deepEqual(summary.cookieDomains, [".example.com"]);
    assert.equal(summary.parent, undefined);
    assert.ok(Date.parse(summary.capturedAt) > 0);

    const loaded = await store.load("A");
    assert.deepEqual(loaded.storageState, state);
  });

  it("stores profiles readable only by the owner", async () => {
    await store.save("perms", { storageState: stateWith({}) });
    const stat = await fs.stat(path.join(dir, "perms.json"));
    assert.equal(stat.mode & 0o777, 0o600, "a profile is a credential file");
  });

  it("records the parent it was branched from", async () => {
    await store.save("child", { storageState: stateWith({}), parent: "A" });
    assert.equal((await store.load("child")).parent, "A");
  });

  it("does not mutate the parent when a branch is saved", async () => {
    const before = await store.load("A");
    await store.save("branch", {
      storageState: stateWith({ origins: ["https://other.example.com"] }),
      parent: "A",
    });
    assert.deepEqual((await store.load("A")).storageState, before.storageState);
  });

  it("lists profiles by name", async () => {
    const names = (await store.list()).map((profile) => profile.name);
    assert.deepEqual(names, [...names].sort());
    assert.ok(names.includes("A") && names.includes("child"));
  });

  it("does not include the storage state in summaries", async () => {
    const [summary] = await store.list();
    assert.equal("storageState" in summary, false);
  });

  it("explains which directory it looked in when a profile is missing", async () => {
    await assert.rejects(() => store.load("nope"), new RegExp(`No profile named "nope" in ${dir}`));
  });

  it("refuses names that would escape the directory", async () => {
    await assert.rejects(
      () => store.save("../escape", { storageState: stateWith({}) }),
      /Invalid profile name/
    );
  });

  it("returns an empty list when nothing has been saved yet", async () => {
    const empty = new ProfileStore(path.join(dir, "does-not-exist"));
    assert.deepEqual(await empty.list(), []);
  });

  it("removes a profile", async () => {
    await store.save("temp", { storageState: stateWith({}) });
    await store.remove("temp");
    await assert.rejects(() => store.load("temp"), /No profile named/);
    // removing again is not an error
    await store.remove("temp");
  });

  it("ignores unrelated files in the directory", async () => {
    await fs.writeFile(path.join(dir, "notes.txt"), "hello");
    await fs.writeFile(path.join(dir, "broken.json"), "{ not json");
    const names = (await store.list()).map((profile) => profile.name);
    assert.ok(!names.includes("notes"));
    assert.ok(!names.includes("broken"), "an unreadable profile must not break listing");
  });
});
