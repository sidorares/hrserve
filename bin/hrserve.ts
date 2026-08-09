#!/usr/bin/env node

import { chromium } from "playwright";
import yargs from "yargs";
import type { ArgumentsCamelCase, Argv } from "yargs";
import { hideBin } from "yargs/helpers";

import { type Rule, createServer } from "../lib/hrserve";
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
}

interface McpArgs {
  headed: boolean;
}

yargs(hideBin(process.argv))
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

      await server.serve({
        url: argv.url,
        dir: argv.dir || process.cwd(),
        rules: rules.length ? rules : undefined,
        width: argv.width,
        height: argv.height,
        verbose: argv.verbose,
      });
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
  .parse();
