#!/usr/bin/env node

import { chromium } from "playwright";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import type { ArgumentsCamelCase, Argv } from "yargs";

import { createServer } from "../lib/hrserve";

interface CLIArgs {
  dir?: string;
  url: string;
  width?: number;
  height?: number;
  devtools: boolean;
  verbose?: boolean;
}

yargs(hideBin(process.argv))
  .command(
    "$0 [dir]",
    "Serve a page, watch for changes in files used on a page and update page content when files are updated",
    (yargs: Argv) => {
      return yargs;
    },
    async (argv: ArgumentsCamelCase<CLIArgs>) => {
      const browser = await chromium.launch({
        headless: false,
        devtools: argv.devtools,
      });

      const server = createServer(browser);

      // Listen for patch events
      server.on("patch", ({ fileName, mimeType }) => {
        console.log(`File patched: ${fileName} (${mimeType})`);
      });

      await server.serve({
        url: argv.url,
        dir: argv.dir || process.cwd(),
        width: argv.width,
        height: argv.height,
        devtools: argv.devtools,
      });
    }
  )
  .option("url", {
    describe: "Base url of the page",
    type: "string",
    default: "http://localhost:3000/",
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
