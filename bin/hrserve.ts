#!/usr/bin/env node

import { chromium } from "playwright";
import yargs from "yargs";
import type { ArgumentsCamelCase, Argv } from "yargs";
import { hideBin } from "yargs/helpers";

import { ProfileStore, createServer } from "../lib/hrserve";

interface CLIArgs {
  dir?: string;
  url: string;
  width?: number;
  height?: number;
  devtools: boolean;
  verbose?: boolean;
  profile?: string;
  saveProfile?: string;
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
        profile: argv.profile,
        width: argv.width,
        height: argv.height,
        verbose: argv.verbose,
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
  .parse();
