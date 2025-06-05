import serveHandler from "serve-handler";
import type { Route } from "playwright";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";

/**
 * Serves directory listings using serve-handler with Playwright routes
 * @param directory - The directory path to serve
 * @param route - The Playwright route to fulfill
 * @param fileName - The file name/path to use as the request URL
 * @returns Promise<void> - Resolves when the serve-handler response stream is finished
 */
export async function serveDirectoryListing(directory: string, route: Route, fileName: string): Promise<void> {
  console.log("serveDirectoryListing", directory, fileName);
  return new Promise((resolve, reject) => {
    // Create minimal mock request object
    const mockRequest = Object.assign(new EventEmitter(), {
      url: fileName.startsWith("/") ? fileName : `/${fileName}`,
      method: "GET",
      headers: {},
    }) as IncomingMessage;

    // Create response object that captures data
    const chunks: Buffer[] = [];
    let statusCode = 200;
    let headers: Record<string, string> = {};

    const mockResponse = Object.assign(new EventEmitter(), {
      writeHead(code: number, responseHeaders?: Record<string, string>) {
        statusCode = code;
        if (responseHeaders) {
          headers = { ...responseHeaders };
        }
      },
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
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
            status: statusCode,
            headers,
            body,
          })
          .then(resolve)
          .catch(reject);
      },
    }) as ServerResponse;

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
