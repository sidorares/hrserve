import path from "node:path";
import type { Browser, BrowserContext, ConsoleMessage, Page } from "playwright";
import {
  type PatchOutcome,
  ProfileStore,
  type ProfileSummary,
  type RequestEvent,
  createServer,
} from "./hrserve";
import type { Rule } from "./rules";

/**
 * Runs several independent hrserve sessions in one browser.
 *
 * Each session gets its own browser context, so N git worktrees can all be
 * served at the *same* canonical URL simultaneously without colliding: the
 * origin is a name inside a context, not a socket on the machine. That is the
 * property port-based dev servers can't offer, and it is what makes parallel
 * agent sessions practical.
 */

export const DEFAULT_SESSION_URL = "http://app.hrserve.test/";

/** Buffers are ring buffers: long-running sessions must not grow without bound. */
const BUFFER_LIMIT = 500;

export interface StartSessionOptions {
  name: string;
  dir: string;
  url?: string;
  rules?: Rule[];
  /** Convenience: adds a mock rule for `mockPath` ahead of the serve rule. */
  mockDir?: string;
  mockPath?: string;
  /** Convenience: proxy `mockPath` requests that no mock route answers. */
  proxy?: string;
  /**
   * Saved profile to start from, so a session begins already logged in
   * instead of repeating a manual sign-in. The session never writes back
   * to it — call `session.saveProfile()` to snapshot the result.
   */
  profile?: string;
  width?: number;
  height?: number;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
  location?: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  /** Where the response came from, in hrserve's terms. */
  source: "served-local" | "mocked" | "proxied" | "upstream" | "blocked";
  timestamp: number;
}

export interface PatchEntry extends PatchOutcome {
  fileName: string;
  mimeType: string;
  timestamp: number;
}

export interface SessionInfo {
  name: string;
  url: string;
  dir: string;
  /** Profile this session started from, if any. */
  profile?: string;
  createdAt: number;
  patches: number;
  /** Console errors + uncaught page exceptions seen so far. */
  errors: number;
}

function describeSource(kind: RequestEvent["kind"]): NetworkEntry["source"] {
  switch (kind) {
    case "file":
    case "fallback":
      return "served-local";
    case "mock":
      return "mocked";
    case "proxy":
      return "proxied";
    case "pass":
      return "upstream";
    default:
      return "blocked";
  }
}

function push<T>(buffer: T[], entry: T): void {
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
}

/** Buffers exist before the page does, so nothing from the first load is missed. */
export interface SessionBuffers {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  patches: PatchEntry[];
}

export class Session {
  readonly name: string;
  readonly url: string;
  readonly dir: string;
  readonly profile?: string;
  readonly createdAt = Date.now();
  readonly console: ConsoleEntry[];
  readonly network: NetworkEntry[];
  readonly patches: PatchEntry[];

  constructor(
    name: string,
    url: string,
    dir: string,
    readonly page: Page,
    readonly context: BrowserContext,
    private readonly server: ReturnType<typeof createServer>,
    buffers: SessionBuffers,
    profile?: string
  ) {
    this.name = name;
    this.url = url;
    this.dir = dir;
    this.profile = profile;
    this.console = buffers.console;
    this.network = buffers.network;
    this.patches = buffers.patches;
  }

  get info(): SessionInfo {
    return {
      name: this.name,
      url: this.url,
      dir: this.dir,
      profile: this.profile,
      createdAt: this.createdAt,
      patches: this.patches.length,
      errors: this.console.filter((entry) => entry.type === "error").length,
    };
  }

  /**
   * Snapshot this session's cookies and storage under a new profile name, so
   * work done here (a sign-in, a captcha) can be reused by later sessions.
   * The profile this session started from is left untouched and recorded as
   * the new snapshot's parent.
   */
  saveProfile(name: string): Promise<ProfileSummary> {
    return this.server.saveProfile(name);
  }

  /** Wait for the next patch — lets an agent await "my edit landed" rather than poll. */
  waitForPatch(timeoutMs = 10_000): Promise<PatchEntry> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.server.off("patch", onPatch);
        reject(new Error(`No patch within ${timeoutMs}ms`));
      }, timeoutMs);
      const onPatch = () => {
        clearTimeout(timer);
        this.server.off("patch", onPatch);
        resolve(this.patches[this.patches.length - 1]);
      };
      this.server.on("patch", onPatch);
    });
  }

  async close(): Promise<void> {
    await this.server.close();
    await this.context.close().catch(() => {});
  }
}

export interface SessionManagerOptions {
  browser: Browser;
  /** Where named profiles are stored. Defaults to the per-user data directory. */
  profilesDir?: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /** The profiles sessions here can start from, in the same directory they save to. */
  readonly profiles: ProfileStore;

  constructor(private readonly options: SessionManagerOptions) {
    this.profiles = new ProfileStore(options.profilesDir);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((session) => session.info);
  }

  get(name: string): Session {
    const session = this.sessions.get(name);
    if (!session) {
      const known = [...this.sessions.keys()];
      throw new Error(
        `No session named "${name}".` +
          (known.length ? ` Running sessions: ${known.join(", ")}.` : " No sessions are running.")
      );
    }
    return session;
  }

  async start(options: StartSessionOptions): Promise<SessionInfo> {
    if (this.sessions.has(options.name)) {
      throw new Error(`A session named "${options.name}" is already running.`);
    }

    const url = options.url ?? DEFAULT_SESSION_URL;
    const dir = path.resolve(options.dir);
    const rules = options.rules ?? buildRules(options);

    const buffers: SessionBuffers = { console: [], network: [], patches: [] };
    const server = createServer(this.options.browser, { profilesDir: this.options.profilesDir });

    // Subscribe before serving: the initial navigation already produces
    // requests and console output, and an agent asking "what happened on load?"
    // must not be told "nothing".
    server.on("request", (event) => {
      push(buffers.network, {
        method: event.method,
        url: event.url,
        source: describeSource(event.kind),
        timestamp: Date.now(),
      });
    });
    server.on("patch", (event) => {
      push(buffers.patches, {
        fileName: event.fileName,
        mimeType: event.mimeType,
        applied: event.applied,
        reason: event.reason,
        timestamp: Date.now(),
      });
    });

    const page = await server.serve({
      url,
      dir,
      rules,
      profile: options.profile,
      width: options.width,
      height: options.height,
      onPage: (page) => {
        page.on("console", (message: ConsoleMessage) => {
          push(buffers.console, {
            type: message.type(),
            text: message.text(),
            timestamp: Date.now(),
            location: message.location()?.url || undefined,
          });
        });
        // Uncaught exceptions never reach page.on("console")
        page.on("pageerror", (error: Error) => {
          push(buffers.console, {
            type: "error",
            text: `Uncaught ${error.message}`,
            timestamp: Date.now(),
          });
        });
      },
    });

    const session = new Session(
      options.name,
      url,
      dir,
      page,
      page.context(),
      server,
      buffers,
      options.profile
    );
    this.sessions.set(options.name, session);
    return session.info;
  }

  async stop(name: string): Promise<void> {
    const session = this.get(name);
    this.sessions.delete(name);
    await session.close();
  }

  async closeAll(): Promise<void> {
    const closing = [...this.sessions.values()].map((session) => session.close());
    this.sessions.clear();
    await Promise.all(closing);
  }
}

/** Turn the mockDir/proxy convenience options into an explicit rule list. */
function buildRules(options: StartSessionOptions): Rule[] | undefined {
  const mockPath = options.mockPath ?? "/api/**";
  const rules: Rule[] = [];
  if (options.mockDir) {
    rules.push({ match: mockPath, action: "mock", dir: path.resolve(options.mockDir) });
  }
  if (options.proxy) {
    rules.push({ match: mockPath, action: "proxy", target: options.proxy });
  }
  if (!rules.length) return undefined;
  rules.push({ action: "serve" });
  return rules;
}
