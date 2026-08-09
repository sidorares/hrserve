import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Session, SessionManager } from "./session-manager";

/**
 * Exposes hrserve sessions over the Model Context Protocol.
 *
 * The tools are chosen around what an agent actually needs after editing a
 * file: did the change reach the page, did it break anything, what does it look
 * like now — questions it otherwise cannot answer without standing up its own
 * browser tooling per worktree.
 *
 * Trust model: `page_eval` runs arbitrary JavaScript in the page, and mock
 * handlers are ordinary modules executed in this process. An MCP client with
 * access to this server can therefore run code locally. Only connect it to
 * clients you would already trust with a shell.
 */

const VERSION = "1.1.0";

const nameArg = z.string().describe("Session name, as passed to serve_start");

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: (error as Error).message }],
  };
}

/** Every tool resolves its session the same way and reports missing ones cleanly. */
function withSession<T>(
  manager: SessionManager,
  name: string,
  action: (session: Session) => Promise<T>
) {
  let session: Session;
  try {
    session = manager.get(name);
  } catch (error) {
    return Promise.resolve(failure(error));
  }
  return action(session)
    .then((result) => text(result))
    .catch((error) => failure(error));
}

export function createMcpServer(manager: SessionManager): McpServer {
  const server = new McpServer({ name: "hrserve", version: VERSION });
  const profiles = manager.profiles;

  server.registerTool(
    "serve_start",
    {
      title: "Start a session",
      description:
        "Serve a directory in its own browser context and open it. Several sessions can " +
        "use the same URL at once (one per worktree, for example) because no port is involved.",
      inputSchema: {
        name: z.string().describe("Unique name for this session, e.g. the worktree name"),
        dir: z.string().describe("Directory to serve"),
        url: z
          .string()
          .optional()
          .describe("Base URL to serve at (default http://app.hrserve.test/)"),
        mockDir: z.string().optional().describe("Directory of file-based mock API routes"),
        mockPath: z.string().optional().describe("Path glob for mocks/proxy (default /api/**)"),
        proxy: z.string().optional().describe("Origin for requests no mock route answers"),
        profile: z
          .string()
          .optional()
          .describe(
            "Saved profile to start from, so the session begins already signed in. " +
              "Omit for a completely fresh session."
          ),
        width: z.number().optional(),
        height: z.number().optional(),
      },
    },
    async (args) => {
      try {
        return text(await manager.start(args));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "serve_list",
    {
      title: "List sessions",
      description: "Running sessions with their directories, URLs, patch and error counts.",
      inputSchema: {},
    },
    async () => text(manager.list())
  );

  server.registerTool(
    "serve_stop",
    {
      title: "Stop a session",
      description: "Close a session's page and stop watching its files.",
      inputSchema: { name: nameArg },
    },
    async ({ name }) => {
      try {
        await manager.stop(name);
        return text(`Stopped session "${name}".`);
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "profile_list",
    {
      title: "List saved profiles",
      description:
        "Saved authentication profiles a session can start from, with the origins each covers, " +
        "when it was captured and which profile it branched from.",
      inputSchema: {},
    },
    async () => {
      try {
        return text(await profiles.list());
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "profile_save",
    {
      title: "Save a session as a profile",
      description:
        "Snapshot a session's current cookies and storage under a new profile name, so a " +
        "sign-in or captcha done once can be reused. Profiles are immutable: this always " +
        "writes a new name and never modifies the one the session started from.",
      inputSchema: {
        name: nameArg,
        as: z.string().describe("Name for the new profile"),
      },
    },
    async ({ name, as }) => withSession(manager, name, (session) => session.saveProfile(as))
  );

  server.registerTool(
    "page_screenshot",
    {
      title: "Screenshot the page",
      description: "PNG screenshot of a session's page, for visual verification after a change.",
      inputSchema: {
        name: nameArg,
        fullPage: z.boolean().optional().describe("Capture the full scrollable page"),
        selector: z.string().optional().describe("Capture only this element"),
      },
    },
    async ({ name, fullPage, selector }) => {
      let session: Session;
      try {
        session = manager.get(name);
      } catch (error) {
        return failure(error);
      }
      try {
        const target = selector ? session.page.locator(selector) : session.page;
        const buffer = await target.screenshot({ ...(selector ? {} : { fullPage: !!fullPage }) });
        return {
          content: [
            { type: "image" as const, data: buffer.toString("base64"), mimeType: "image/png" },
          ],
        };
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "page_console",
    {
      title: "Read console output",
      description:
        "Buffered console messages and uncaught exceptions — the first thing to check after a patch.",
      inputSchema: {
        name: nameArg,
        onlyErrors: z.boolean().optional().describe("Only errors and uncaught exceptions"),
        since: z.number().optional().describe("Unix ms timestamp; only entries after it"),
        limit: z.number().optional().describe("Most recent N entries (default 100)"),
      },
    },
    async ({ name, onlyErrors, since, limit }) =>
      withSession(manager, name, async (session) => {
        let entries = session.console;
        if (onlyErrors) entries = entries.filter((entry) => entry.type === "error");
        if (since) entries = entries.filter((entry) => entry.timestamp > since);
        return entries.slice(-(limit ?? 100));
      })
  );

  server.registerTool(
    "page_network",
    {
      title: "Read the request log",
      description:
        "Requests with how each was answered (served-local, mocked, proxied, upstream, blocked) — " +
        "this is what explains routing surprises.",
      inputSchema: {
        name: nameArg,
        limit: z.number().optional().describe("Most recent N entries (default 100)"),
        source: z
          .enum(["served-local", "mocked", "proxied", "upstream", "blocked"])
          .optional()
          .describe("Only requests answered this way"),
      },
    },
    async ({ name, limit, source }) =>
      withSession(manager, name, async (session) => {
        const entries = source
          ? session.network.filter((entry) => entry.source === source)
          : session.network;
        return entries.slice(-(limit ?? 100));
      })
  );

  server.registerTool(
    "patch_history",
    {
      title: "Read patch history",
      description:
        "Files patched into the running page, each with whether it was actually applied and why " +
        "not (invalid CSS, stylesheet not loaded, LiveEdit unavailable).",
      inputSchema: {
        name: nameArg,
        limit: z.number().optional().describe("Most recent N entries (default 50)"),
      },
    },
    async ({ name, limit }) =>
      withSession(manager, name, async (session) => session.patches.slice(-(limit ?? 50)))
  );

  server.registerTool(
    "wait_for_patch",
    {
      title: "Wait for the next patch",
      description:
        "Block until the next file patch lands, so an edit can be verified without polling.",
      inputSchema: {
        name: nameArg,
        timeoutMs: z.number().optional().describe("Default 10000"),
      },
    },
    async ({ name, timeoutMs }) =>
      withSession(manager, name, (session) => session.waitForPatch(timeoutMs ?? 10_000))
  );

  server.registerTool(
    "page_dom",
    {
      title: "Read page text",
      description: "Visible text of the page (or one element) for non-visual assertions.",
      inputSchema: {
        name: nameArg,
        selector: z.string().optional().describe("Element to read (default: body)"),
        html: z.boolean().optional().describe("Return HTML markup instead of text"),
      },
    },
    async ({ name, selector, html }) =>
      withSession(manager, name, async (session) => {
        const locator = session.page.locator(selector ?? "body");
        return html ? await locator.innerHTML() : await locator.innerText();
      })
  );

  server.registerTool(
    "page_eval",
    {
      title: "Evaluate JavaScript",
      description:
        "Run an expression in the page and return its result. Escape hatch for inspecting state.",
      inputSchema: {
        name: nameArg,
        expression: z.string().describe("JavaScript expression evaluated in the page"),
      },
    },
    async ({ name, expression }) =>
      withSession(manager, name, async (session) => {
        const result = await session.page.evaluate(expression);
        return result === undefined ? "undefined" : result;
      })
  );

  server.registerTool(
    "page_reload",
    {
      title: "Reload the page",
      description: "Full reload, discarding patched state.",
      inputSchema: { name: nameArg },
    },
    async ({ name }) =>
      withSession(manager, name, async (session) => {
        await session.page.reload();
        return `Reloaded "${name}".`;
      })
  );

  server.registerTool(
    "set_viewport",
    {
      title: "Resize the viewport",
      description: "Change the page's viewport, e.g. to check a responsive layout.",
      inputSchema: {
        name: nameArg,
        width: z.number(),
        height: z.number(),
      },
    },
    async ({ name, width, height }) =>
      withSession(manager, name, async (session) => {
        await session.page.setViewportSize({ width, height });
        return `Viewport set to ${width}x${height}.`;
      })
  );

  return server;
}
