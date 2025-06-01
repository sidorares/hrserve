# hrserve

A development server that serves web pages and automatically patches file changes without full page reloads using Playwright.

## CLI Usage

```bash
node bin/hrserve.js [dir] --url http://localhost:3000
```

Options:
- `--url`: Base URL of the page (default: "https://www.google.com")
- `--devtools, -d`: Run with devtools initially open
- `--verbose, -v`: Run with verbose logging
- `--width, -w`: Width of the browser window
- `--height, -h`: Height of the browser window

## Programmatic Usage

```javascript
import { chromium } from "playwright";
import { createServer } from "./lib/hrserve.js";

async function example() {
  // Create browser
  const browser = await chromium.launch({
    headless: false,
    devtools: true,
  });

  // Create server
  const server = createServer(browser);

  // Listen for patch events
  server.on('patch', ({ fileName, mimeType }) => {
    console.log(`File patched: ${fileName} (${mimeType})`);
  });

  // Start serving
  await server.serve({
    url: "http://your-project-host.com",
    dir: "./public",
    width: 1200,
    height: 800,
    devtools: true,
  });
}
```

### API

#### `createServer(browser)`

Creates a new hrserve instance.

**Parameters:**
- `browser`: A Playwright browser instance

**Returns:** Server object with the following methods:

#### `server.serve(options)`

Starts serving files and watching for changes.

**Parameters:**
- `options.url`: The base URL to serve
- `options.dir`: Directory to serve files from
- `options.width`: Browser window width (default: 1280)
- `options.height`: Browser window height (default: 720)
- `options.devtools`: Whether to open devtools (default: false)

#### `server.on(event, handler)`

Listen for server events.

**Events:**
- `'patch'`: Emitted when a file is patched. Handler receives `{ fileName, mimeType }`

## Supported File Types

- **CSS**: Live updates without page reload
- **JavaScript**: Hot module replacement with script patching
- **HTML**: Full DOM replacement
- **Images**: Automatic image reload (PNG, JPG, GIF, SVG, WebP)
