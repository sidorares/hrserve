import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext } from "playwright";

/**
 * Saved authentication state for sessions.
 *
 * A profile is an **immutable snapshot** of Playwright's `storageState` —
 * cookies, per-origin localStorage and IndexedDB — stored as one JSON file.
 * Sessions read profiles and never write back, which is what makes branching
 * safe and trivial: "start from A" and "save as C" are the only operations, so
 * A → B, A → C, C → D needs no copy-on-write, locking or refcounting, and two
 * sessions started from the same profile cannot corrupt each other.
 *
 * Deliberately *not* a browser user-data directory: those are locked by
 * Chromium and need a browser process each, which would prevent two sessions
 * from sharing one profile — the whole point here. The cost is fidelity: a
 * profile cannot carry sessionStorage, service worker caches, HTTP auth,
 * WebAuthn credentials or extensions.
 */

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface ProfileSummary {
  name: string;
  /** The profile this one was branched from. Metadata only — never resolved
   * through: every snapshot is flat and complete. */
  parent?: string;
  capturedAt: string;
  /** Origins with stored localStorage/IndexedDB. */
  origins: string[];
  /** Domains of the stored cookies, as the browser reported them. */
  cookieDomains: string[];
}

export interface Profile extends ProfileSummary {
  storageState: StorageState;
}

/** Profiles hold live session cookies, so they live outside the repository. */
export function defaultProfilesDir(): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim();
  const base =
    dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(os.homedir(), ".local", "share");
  return path.join(base, "hrserve", "profiles");
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Names become file names, so they must not be able to escape the directory. */
export function assertValidProfileName(name: string): void {
  if (!NAME_PATTERN.test(name) || name.includes("..")) {
    throw new Error(
      `Invalid profile name "${name}": use letters, digits, dot, dash or underscore (max 64 chars, starting alphanumeric).`
    );
  }
}

function summarize(state: StorageState): Pick<ProfileSummary, "origins" | "cookieDomains"> {
  return {
    origins: [...new Set(state.origins?.map((entry) => entry.origin) ?? [])],
    cookieDomains: [...new Set(state.cookies?.map((cookie) => cookie.domain) ?? [])],
  };
}

function hostMatchesCookieDomain(hostname: string, domain: string): boolean {
  const bare = domain.replace(/^\./, "").toLowerCase();
  const host = hostname.toLowerCase();
  return host === bare || host.endsWith(`.${bare}`);
}

/**
 * Would this profile's state actually apply to `url`?
 *
 * storageState is origin-scoped while hrserve deliberately serves local files
 * at arbitrary origins, so a profile captured on the real site does nothing for
 * a session served at a fake origin — and the symptom is a silently logged-out
 * page. Checking up front turns that into a warning that names the mismatch.
 */
export function profileCoversUrl(
  profile: Pick<ProfileSummary, "origins" | "cookieDomains">,
  url: string
): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (profile.origins.includes(target.origin)) return true;
  return profile.cookieDomains.some((domain) => hostMatchesCookieDomain(target.hostname, domain));
}

export class ProfileStore {
  readonly dir: string;

  constructor(dir: string = defaultProfilesDir()) {
    this.dir = path.resolve(dir);
  }

  private file(name: string): string {
    assertValidProfileName(name);
    return path.join(this.dir, `${name}.json`);
  }

  async save(
    name: string,
    options: { storageState: StorageState; parent?: string }
  ): Promise<ProfileSummary> {
    const file = this.file(name);
    const profile: Profile = {
      name,
      parent: options.parent,
      capturedAt: new Date().toISOString(),
      ...summarize(options.storageState),
      storageState: options.storageState,
    };

    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Write-then-rename so an interrupted save cannot leave a torn profile
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(profile, null, 2), { mode: 0o600 });
    await fs.chmod(temp, 0o600);
    await fs.rename(temp, file);

    const { storageState: _ignored, ...summary } = profile;
    return summary;
  }

  async load(name: string): Promise<Profile> {
    const file = this.file(name);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf-8");
    } catch {
      throw new Error(`No profile named "${name}" in ${this.dir}`);
    }
    try {
      return JSON.parse(raw) as Profile;
    } catch (e) {
      throw new Error(`Profile "${name}" is not valid JSON (${(e as Error).message})`);
    }
  }

  async list(): Promise<ProfileSummary[]> {
    const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
    const summaries: ProfileSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const profile = await this.load(path.basename(entry, ".json")).catch(() => null);
      if (!profile) continue;
      const { storageState: _ignored, ...summary } = profile;
      summaries.push(summary);
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(name: string): Promise<void> {
    await fs.rm(this.file(name), { force: true });
  }
}
