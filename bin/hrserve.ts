#!/usr/bin/env node

import { chromium } from "playwright";
import yargs from "yargs";
import type { ArgumentsCamelCase, Argv } from "yargs";
import { hideBin } from "yargs/helpers";

import { ProfileStore, type Rule, type ScriptReloadMode, createServer } from "../lib/hrserve";
import { createMcpServer } from "../lib/mcp-server";
import { SessionManager } from "../lib/session-manager";

interface CLIArgs {
  dir?: string;
  url: string;
  width?: number;
  height?: number;
  devtools: boolean;
  verbose?: boolean;
  mockDir?: string;
  mockPath?: string;
  proxy?: string;
  profile?: string;
  saveProfile?: string;
  scriptReload: ScriptReloadMode;
}

interface McpArgs {
  headed: boolean;
}

yargs(hideBin(process.argv))
  .command(
    "profiles",
    "List saved profiles (cookies and storage captured from earlier sessions)",
    (yargs: Argv) => yargs,
    async () => {
      const store = new ProfileStore();
      const profiles = await store.list();
      console.log(`Profiles in ${store.dir}`);
      if (!profiles.length) {
        console.log("  (none yet — run with --save-profile <name> to capture one)");
        return;
      }
      for (const profile of profiles) {
        const scope = [...profile.origins, ...profile.cookieDomains].join(", ") || "empty";
        const from = profile.parent ? ` (from ${profile.parent})` : "";
        console.log(
          `  ${profile.name}${from}\n    captured ${profile.capturedAt}\n    covers   ${scope}`
        );
      }
    }
  )
  .command(
    "mcp",
    "Run an MCP server so agents can start sessions and inspect their pages",
    (yargs: Argv) =>
      yargs.option("headed", {
        type: "boolean",
        default: false,
        description: "Show the browser window instead of running headless",
      }),
    async (argv: ArgumentsCamelCase<McpArgs>) => {
      // stdout is the MCP protocol stream: anything written to it corrupts the
      // session, including a stray console.log inside a user's mock handler.
      console.log = (...args: unknown[]) => console.error(...args);

      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const browser = await chromium.launch({ headless: !argv.headed });
      const manager = new SessionManager({ browser });
      const server = createMcpServer(manager);

      const shutdown = async () => {
        await manager.closeAll().catch(() => {});
        await browser.close().catch(() => {});
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      await server.connect(new StdioServerTransport());
      console.error("hrserve MCP server ready");
    }
  )
  .command(
    "$0 [dir]",
    "Serve a page, watch for changes in files used on a page and update page content when files are updated",
    (yargs: Argv) => {
      return yargs;
    },
    async (argv: ArgumentsCamelCase<CLIArgs>) => {
      const browser = await chromium.launch({
        headless: false,
        // The `devtools` launch option was removed in newer Playwright versions
        args: argv.devtools ? ["--auto-open-devtools-for-tabs"] : [],
      });

      const server = createServer(browser);

      // Listen for patch events
      server.on("patch", ({ fileName, mimeType }) => {
        console.log(`File patched: ${fileName} (${mimeType})`);
      });

      // Mocks (and an optional proxy for everything they don't cover) take
      // precedence over files; the catch-all keeps normal serving behaviour.
      const rules: Rule[] = [];
      if (argv.mockDir) {
        rules.push({ match: argv.mockPath, action: "mock", dir: argv.mockDir });
      }
      if (argv.proxy) {
        rules.push({ match: argv.mockPath, action: "proxy", target: argv.proxy });
      }
      if (rules.length) {
        rules.push({ action: "serve" });
      }

      // Capture on exit: the point of --save-profile is to keep manual work
      // (a login, a captcha) that only exists once the session has been used.
      if (argv.saveProfile) {
        const saveAndExit = async () => {
          try {
            const saved = await server.saveProfile(argv.saveProfile as string);
            console.log(
              `\nSaved profile "${saved.name}" covering ${saved.origins.join(", ") || "no origins"}`
            );
          } catch (e) {
            console.error(`\nCould not save profile: ${(e as Error).message}`);
          }
          await browser.close().catch(() => {});
          process.exit(0);
        };
        process.on("SIGINT", saveAndExit);
        process.on("SIGTERM", saveAndExit);
      }

      await server.serve({
        url: argv.url,
        dir: argv.dir || process.cwd(),
        rules: rules.length ? rules : undefined,
        profile: argv.profile,
        width: argv.width,
        height: argv.height,
        verbose: argv.verbose,
        scriptReload: argv.scriptReload,
      });

      if (argv.saveProfile) {
        console.log(`Press Ctrl-C to save this session as profile "${argv.saveProfile}".`);
      }
    }
  )
  .option("url", {
    describe: "Base url of the page",
    type: "string",
    default: "http://localhost:3000/",
  })
  .option("mock-dir", {
    type: "string",
    description: "Directory of file-based mock API routes (Next.js conventions), run in-process",
  })
  .option("mock-path", {
    type: "string",
    description: "Path glob handled by --mock-dir / --proxy",
    default: "/api/**",
  })
  .option("proxy", {
    type: "string",
    description: "Send --mock-path requests without a mock route to this origin",
  })
  .option("profile", {
    type: "string",
    description: "Start from a saved profile's cookies and storage",
  })
  .option("save-profile", {
    type: "string",
    description: "On Ctrl-C, save this session's cookies and storage under this name",
  })
  .option("devtools", {
    alias: "d",
    type: "boolean",
    description: "Run with devtools initially open",
    default: false,
  })
  .option("verbose", {
    alias: "v",
    type: "boolean",
    description: "Run with verbose logging",
  })
  .option("width", {
    alias: "w",
    type: "number",
    description: "Width of the browser window",
  })
  .option("height", {
    alias: "h",
    type: "number",
    description: "Height of the browser window",
  })
  .option("script-reload", {
    type: "string",
    choices: ["auto", "evaluate", "import", "off"] as const,
    description:
      "How to apply changed JavaScript: re-run classic scripts and re-import modules (auto), " +
      "force one mechanism, or only dispatch the script-patch event (off)",
    default: "auto" as const,
  })
  .parse();
