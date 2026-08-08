---
id: mock-api
title: Mock API routes
sidebar_label: Mock API routes
---

# Mock API routes

Mocking a few endpoints usually means running the real backend or standing up a separate mock server — another port, another process, and routing semantics that differ from your app's. hrserve executes file-based API routes **inside its own process**: no port, no spawned server, no framework.

```bash
npx hrserve ./public --mock-dir ./mocks --proxy https://staging-api.example.com
```

```javascript
await server.serve({
  url: "http://localhost:3000/",
  dir: "./public",
  rules: [
    { match: "/api/**", action: "mock", dir: "./mocks" },
    // anything the mocks don't cover reaches the real API
    { match: "/api/**", action: "proxy", target: "https://staging-api.example.com" },
    { match: "**", action: "serve" },
  ],
});
```

A mock rule that finds no matching route **falls through to the next rule**, which is what makes the two-line "mock what exists, proxy the rest" setup above work without listing every endpoint.

## File conventions

The directory mirrors the URL space and follows **Next.js conventions**, so you can point it at a purpose-built `mocks/` folder *or* straight at a real Next app's `app/` or `pages/` directory:

| File (relative to the mock dir) | URL |
|---|---|
| `api/users/route.ts` | `/api/users` |
| `api/users/[id]/route.ts` | `/api/users/:id` |
| `api/files/[...path]/route.ts` | `/api/files/*` (one or more segments) |
| `api/docs/[[...slug]]/route.ts` | `/api/docs` **and** `/api/docs/*` |
| `api/users.ts` (pages style) | `/api/users` |
| `api/posts/index.ts` | `/api/posts` |

Resolution follows Next's priority — **static beats dynamic beats catch-all** — so `/api/users` wins over `/api/[id]`. Route groups `(admin)` and parallel routes `@modal` don't affect the URL. App Router UI files (`page`, `layout`, `loading`, …) and `_`-prefixed files are ignored.

## App Router style

A `route.ts` exporting HTTP method functions, using Web `Request`/`Response`:

```typescript
const todos = [{ id: 1, title: "write tests" }];

export function GET() {
  return Response.json(todos);
}

export async function POST(request: Request) {
  const { title } = await request.json();
  const todo = { id: todos.length + 1, title };
  todos.push(todo);                  // module state survives between requests
  return Response.json(todo, { status: 201 });
}

export async function PATCH(request: Request, ctx: { params: { id: string } }) {
  const { id } = await ctx.params;   // Next 15 style
  return Response.json({ id });
}
```

`params` works both ways: `await ctx.params` (Next 15) and `ctx.params.id` directly (Next 14), because mock code gets written both ways.

`HEAD` falls back to `GET`, `OPTIONS` is answered automatically, and calling a method the file doesn't export returns 405 with an `Allow` header.

## Pages Router style

A default export taking `(req, res)`:

```javascript
export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }
  res.setHeader("x-mocked", "yes");
  res.status(201).json({ id: req.query.id, body: req.body });
}
```

`req` gives you `method`, `url`, `headers`, `query` (route params merged with the query string), `cookies` and a parsed `body` (JSON and urlencoded). `res` supports `status()`, `json()`, `send()`, `setHeader()`, `redirect()`, `write()` and `end()`.

## Hot reload and state

TypeScript handlers run through [jiti](https://github.com/unjs/jiti), so there is no build step.

- Editing a handler takes effect on the **next request**.
- Module-level state (an in-memory list, a counter) is **preserved between requests** and **reset when the file changes** — so a POST followed by a GET sees the new item, but saving the file gives you a clean slate.
- Adding or deleting route files is picked up automatically.

## What this is not

A mock layer, not a Next.js runtime. Out of scope: `middleware.ts`, the edge runtime, ISR/SSG, and `next/headers`-style request context beyond what a plain `Request` carries.

:::caution Handlers are code you run
Mock handlers are ordinary modules executed in the hrserve process, with full access to your machine. Treat a mock directory like any other source you execute.
:::
