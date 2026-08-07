import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "playwright";
import serveHandler from "serve-handler";

/**
 * Serves directory listings and 404 pages using serve-handler with Playwright routes
 * @param directory - The directory path to serve
 * @param route - The Playwright route to fulfill
 * @param urlPath - The request URL path (relative to the served root, e.g. "/sub/")
 * @returns Promise<void> - Resolves when the serve-handler response has been fulfilled
 */
export async function serveDirectoryListing(
  directory: string,
  route: Route,
  urlPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Create minimal mock request object
    const mockRequest = Object.assign(new EventEmitter(), {
      url: urlPath.startsWith("/") ? urlPath : `/${urlPath}`,
      method: "GET",
      headers: {},
    }) as IncomingMessage;

    // Create response object that captures data.
    // serve-handler both assigns `response.statusCode` directly and calls
    // writeHead(), and mixes setHeader() with writeHead() headers, so the mock
    // has to keep a real statusCode property and merge (not replace) headers.
    const chunks: Buffer[] = [];
    const headers: Record<string, string> = {};

    const mockResponse = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writeHead(code: number, responseHeaders?: Record<string, string>) {
        mockResponse.statusCode = code;
        for (const [name, value] of Object.entries(responseHeaders ?? {})) {
          headers[name.toLowerCase()] = String(value);
        }
        return mockResponse;
      },
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = String(value);
        return mockResponse;
      },
      write(chunk: Buffer | string) {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return true;
      },
      end(chunk?: Buffer | string) {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        const body = Buffer.concat(chunks);

        route
          .fulfill({
            status: mockResponse.statusCode,
            headers,
            body,
          })
          .then(resolve)
          .catch(reject);
      },
    }) as unknown as ServerResponse;

    // Configure serve-handler for directory listing
    const config = {
      public: directory,
      directoryListing: true,
      renderSingle: false,
    };

    // Call serve-handler with mock request/response
    serveHandler(mockRequest, mockResponse, config).catch(reject);
  });
}
