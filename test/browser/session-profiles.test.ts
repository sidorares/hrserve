import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type Browser, chromium } from "playwright";
import { createMcpServer } from "../../lib/mcp-server";
import { SessionManager } from "../../lib/session-manager";

let browser: Browser;
let manager: SessionManager;
let client: Client;
let profilesDir: string;
let siteDir: string;

interface ToolContent {
  type: string;
  text?: string;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: ToolContent[];
  };
}

const textOf = (result: { content: ToolContent[] }) =>
  result.content.map((entry) => entry.text ?? "").join("\n");
const jsonOf = (result: { content: ToolContent[] }) => JSON.parse(textOf(result));

const readToken = () => window.localStorage.getItem("token");

before(async () => {
  browser = await chromium.launch({ headless: true });
  profilesDir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-sessprof-"));
  siteDir = await fs.mkdtemp(path.join(os.tmpdir(), "hrserve-sessprofsite-"));
  await fs.writeFile(
    path.join(siteDir, "index.html"),
    "<!DOCTYPE html><html><body><h1>app</h1></body></html>"
  );

  manager = new SessionManager({ browser, profilesDir });
  const server = createMcpServer(manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-agent", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
  await manager.closeAll();
  await browser.close();
  await fs.rm(profilesDir, { recursive: true, force: true });
  await fs.rm(siteDir, { recursive: true, force: true });
});

describe("sessions starting from profiles", () => {
  it("saves a session's state and starts later sessions already signed in", async () => {
    // The manual step an agent cannot do for itself, done once
    await manager.start({ name: "signin", dir: siteDir });
    const signin = manager.get("signin");
    assert.equal(signin.info.profile, undefined, "a fresh session reports no profile");
    await signin.page.evaluate(() => window.localStorage.setItem("token", "signed-in"));

    const saved = await signin.saveProfile("agent-login");
    assert.equal(saved.name, "agent-login");
    assert.equal(saved.parent, undefined);
    await manager.stop("signin");

    // Every later session starts from it, without repeating the sign-in
    const info = await manager.start({
      name: "worker",
      dir: siteDir,
      profile: "agent-login",
    });
    assert.equal(info.profile, "agent-login", "the session reports what it started from");
    assert.equal(await manager.get("worker").page.evaluate(readToken), "signed-in");
    await manager.stop("worker");
  });

  it("keeps parallel sessions from one profile independent", async () => {
    await manager.start({ name: "wt-a", dir: siteDir, profile: "agent-login" });
    await manager.start({ name: "wt-b", dir: siteDir, profile: "agent-login" });
    try {
      const a = manager.get("wt-a");
      const b = manager.get("wt-b");
      assert.equal(await a.page.evaluate(readToken), "signed-in");
      assert.equal(await b.page.evaluate(readToken), "signed-in");

      // One worktree's session changing state must not leak into the other
      await a.page.evaluate(() => window.localStorage.setItem("scratch", "only-a"));
      assert.equal(
        await b.page.evaluate(() => window.localStorage.getItem("scratch")),
        null,
        "sessions from the same profile stay isolated"
      );
    } finally {
      await manager.stop("wt-a");
      await manager.stop("wt-b");
    }
  });

  it("records lineage when a session is saved as a new profile", async () => {
    await manager.start({ name: "extra", dir: siteDir, profile: "agent-login" });
    try {
      const session = manager.get("extra");
      await session.page.evaluate(() => window.localStorage.setItem("mfa", "done"));
      const saved = await session.saveProfile("agent-login-mfa");
      assert.equal(saved.parent, "agent-login", "the profile it started from is the parent");
    } finally {
      await manager.stop("extra");
    }

    // The original profile is untouched, so it stays reproducible
    await manager.start({ name: "check", dir: siteDir, profile: "agent-login" });
    try {
      assert.equal(
        await manager.get("check").page.evaluate(() => window.localStorage.getItem("mfa")),
        null
      );
    } finally {
      await manager.stop("check");
    }
  });

  it("exposes profiles to agents over MCP", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("profile_list"));
    assert.ok(names.includes("profile_save"));

    const listed = jsonOf(await callTool("profile_list")) as Array<{
      name: string;
      parent?: string;
    }>;
    assert.deepEqual(listed.map((profile) => profile.name).sort(), [
      "agent-login",
      "agent-login-mfa",
    ]);
    assert.equal(listed.find((p) => p.name === "agent-login-mfa")?.parent, "agent-login");

    // An agent can start from a profile and snapshot its own result
    const started = jsonOf(
      await callTool("serve_start", {
        name: "mcp-session",
        dir: siteDir,
        profile: "agent-login",
      })
    ) as { profile?: string };
    assert.equal(started.profile, "agent-login");

    // page_eval returns string results as plain text, not JSON
    const token = textOf(
      await callTool("page_eval", {
        name: "mcp-session",
        expression: "window.localStorage.getItem('token')",
      })
    );
    assert.equal(token, "signed-in");

    const saved = jsonOf(
      await callTool("profile_save", { name: "mcp-session", as: "from-mcp" })
    ) as {
      name: string;
      parent?: string;
    };
    assert.equal(saved.name, "from-mcp");
    assert.equal(saved.parent, "agent-login");

    await callTool("serve_stop", { name: "mcp-session" });
  });

  it("reports a clear error when the profile does not exist", async () => {
    const result = await callTool("serve_start", {
      name: "ghost-session",
      dir: siteDir,
      profile: "no-such-profile",
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No profile named "no-such-profile"/);
    // ...and the failed session is not left registered
    assert.ok(!manager.list().some((session) => session.name === "ghost-session"));
  });
});
