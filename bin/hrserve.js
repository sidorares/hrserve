#! /usr/bin/env node

import puppeteer from "puppeteer";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import chokidar from "chokidar";
import mime from "mime-types";
import fs from "node:fs/promises";
import path from "node:path";
import { validate } from "csstree-validator";

const watchers = new Map();
const patchers = new Map();
const scriptUrlToDetails = new Map();
const stylesheetUrlToId = new Map();

patchers.set("text/css", async (page, url, newContent) => {
  const validationResult = validate(newContent, path);
  if (validationResult.length) {
    console.log("CSS validation failed:", validationResult);
    return;
  }
  const styleSheetId = stylesheetUrlToId.get(url);
  const result = await cdp.send("CSS.setStyleSheetText", {
    styleSheetId,
    text: newContent,
  });
  console.log("result", result);
});

patchers.set("application/javascript", async (page, url, scriptSource) => {
  const cdp = await page.createCDPSession();
  const scriptDetails = scriptUrlToDetails.get(url);
  if (!scriptDetails) {
    return;
  }
  await cdp.send("Debugger.enable");
  const result = await cdp.send("Debugger.setScriptSource", {
    scriptId: scriptDetails.scriptId,
    scriptSource,
    allowTopFrameEditing: true,
  });

  console.log("result", result);
  if (result.status !== "Ok") {
    return;
  }

  const detail = JSON.stringify({
    detail: {
      scriptUrl: url,
    },
  });
  const expression = `(function() {
        const event = new CustomEvent(
          'script-patch',
          ${detail}  
        );
        window.dispatchEvent(event);
      })();`;

  await cdp.send("Runtime.evaluate", {
    expression,
  });

  try {
    console.log(
      "evaluating in script context",
      scriptDetails.executionContextId
    );
    const r = await cdp.send("Runtime.evaluate", {
      expression: "import.meta",
      contextId: scriptDetails.executionContextId,
    });
    console.log("Runtime.evaluate", r);
  } catch (e) {
    console.log("Error evaluating", e);
  }
});

patchers.set("text/html", async (page, _url, newContent) => {
  const cdp = await page.createCDPSession();
  const {
    root: { nodeId: rootNodeId },
  } = await cdp.send("DOM.getDocument");
  await cdp.send("DOM.setOuterHTML", {
    nodeId: rootNodeId,
    outerHTML: newContent,
  });
});

yargs(hideBin(process.argv))
  .command(
    "$0 [dir]",
    "Serve a page and watch for changes in html, js and css files",
    (yargs) => {},
    async (argv) => {
      console.log("-----", argv);
      const browser = await puppeteer.launch({
        headless: false,
        devtools: argv.devtools,
        args: [`--window-size=${argv.width},${argv.height}`],
      });

      const prefix = argv.url;

      const page = await browser.newPage();
      await page.bringToFront();
      
      await page.setRequestInterception(true);

      const cdp = await page.createCDPSession();
      await cdp.send("Debugger.enable");
      await cdp.send("DOM.enable");
      await cdp.send("Page.enable");
      await cdp.send("CSS.enable");
      await cdp.send("Runtime.enable");
      cdp.on("Debugger.scriptParsed", (event) => {
        // console.log("Script parsed", event);
        scriptUrlToDetails.set(event.url, event);
      });
      cdp.on("CSS.styleSheetAdded", (event) => {
        stylesheetUrlToId.set(
          event.header.sourceURL,
          event.header.styleSheetId
        );
      });

      const watchEvent = (name) => {
        cdp.on(name, (event) => {
            console.log(name, event);
        });
      };

      watchEvent("DOM.attributeModified");
      watchEvent("DOM.attributeRemoved");
        watchEvent("DOM.characterDataModified");
        watchEvent("DOM.childNodeCountUpdated");
        watchEvent("DOM.childNodeInserted");
        watchEvent("DOM.childNodeRemoved");
        watchEvent("DOM.distributedNodesUpdated");
        watchEvent("DOM.inlineStyleInvalidated");
        watchEvent("DOM.pseudoElementAdded");
        watchEvent("DOM.pseudoElementRemoved");
        watchEvent("DOM.setChildNodes");
        watchEvent("DOM.shadowRootPopped");
        watchEvent("DOM.shadowRootPushed");
        watchEvent("DOM.documentUpdated");
        watchEvent("DOM.topLayerElementUpdated");

      page.on("request", async (request) => {
        const url = request.url();
        console.log("Requesting", prefix, url);
        if (request.method() === "GET" && url.startsWith(prefix)) {
          let filename = path.join(argv.dir, url.replace(prefix, ""));
          console.log("File exist?", filename);
          const fileExist = await fs
            .access(filename, fs.constants.F_OK)
            .then(() => true)
            .catch(() => false);

          console.log("File exist?", fileExist);

          if (url.endsWith("/")) {
            filename = path.join(
              argv.dir,
              url.replace(prefix, ""),
              "index.html"
            );
          }

          if (!fileExist) {
            console.log("File does not exist", filename);
            request.respond({
              status: 404,
            });
            return;
          }

          const mimeType = mime.lookup(filename);
          const body = await fs.readFile(filename);
          request.respond({
            body: body,
            status: 200,
            headers: {
              "Content-Type": mimeType,
            },
          });
          if (!watchers.has(url)) {
            if (patchers.has(mimeType)) {
              const watcher = chokidar.watch(filename);
              console.log("Watching:", filename, url);
              const patcher = patchers.get(mimeType);
              watcher.on("change", async () => {
                const newContent = await fs.readFile(filename, "utf-8");
                console.log("Patching", url);
                patcher(page, url, newContent);

                const doc = await cdp.send("DOM.getDocument", { depth: 10 });
                console.log("Document", doc);
        
              });
              watchers.set(url, watcher);
            }
          }
        } else {
          request.continue();
        }
      });
      

      console.log("Opening page", argv.url);
      await page.goto(argv.url);
    }
  )
  .option("url", {
    describe: "Base url of the page",
    type: "string",
    default: "https://www.google.com",
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
