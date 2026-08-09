---
id: routing
title: Routing rules
sidebar_label: Routing rules
---

# Routing rules

By default every `GET` under the base URL is served from `dir`. Pass `rules` to mix local files with real network traffic — an ordered list where the **first match wins**:

```javascript
await server.serve({
  url: "https://app.example.com/",
  dir: "./dist",
  rules: [
    { match: "/assets/**", action: "serve", dir: "./dist/assets" },
    { match: "/api/**", action: "proxy", target: "https://staging-api.example.com" },
    { match: "/health", action: "upstream" },
    { match: "**", action: "serve" },
  ],
});
```

`match` is a glob ([picomatch](https://github.com/micromatch/picomatch) syntax) tested against the request path **relative to the base URL** — with a base of `https://app.example.com/`, the rule `/api/**` matches `https://app.example.com/api/users`. It defaults to `**`. An optional `methods: ["POST"]` narrows a rule to specific HTTP methods.

Requests matching **no** rule go to the network, so a rule list without a `**` entry is an *overlay* rather than a full server.

## Actions

### `serve`

Answer from a directory, falling back to a directory listing or 404 page. `GET`/`HEAD` only — other methods go to the network. Served files are watched and patched as usual.

`dir` defaults to the top-level `dir` and mirrors the URL space beneath it, which gives you multiple mount points for free:

```javascript
rules: [
  { match: "/ui/**", action: "serve", dir: "../packages/ui/dist" },
  { match: "**", action: "serve", dir: "./dist" },
]
```

### `upstream`

Let the request through to the real network, untouched. Useful for carving holes in an overlay — everything local except the health check, or except analytics.

### `proxy`

Send the request to another origin, preserving path, query, method, headers and body:

```javascript
{ match: "/api/**", action: "proxy", target: "https://staging-api.example.com" }
```

A path prefix on the target is kept: target `https://example.com/v2` + request `/api/users` → `https://example.com/v2/api/users`. If the target is unreachable, the page gets a 502.

:::tip No CORS
hrserve performs the proxied request itself, from Node, and returns the result as if it came from the page's own origin. The browser never sees a cross-origin request, so **CORS does not apply** — you can point a page at a completely different backend without touching its headers.
:::

### `mock`

Answer from [file-based API routes](./mock-api.md) executed in this process. If no mock route matches the path, the request falls through to the **next** rule — which is what makes "mock what exists, proxy the rest" a two-line config:

```javascript
rules: [
  { match: "/api/**", action: "mock", dir: "./mocks" },
  { match: "/api/**", action: "proxy", target: "https://staging-api.example.com" },
  { match: "**", action: "serve" },
]
```

## Overlaying a real site

Because the base URL can be any origin, you can serve local files *at* a production URL and let everything else stay real:

```javascript
await server.serve({
  url: "https://app.example.com/",
  dir: "./dist",
  rules: [
    { match: "/assets/**", action: "serve" },  // your local build
    { match: "**", action: "upstream" },       // the real site
  ],
});
```

Combine that with a [profile](./profiles.md) to get past the login screen.

:::caution Service workers and CSP
Two things can defeat an overlay on a real site: a service worker answering requests before hrserve sees them, and a strict Content-Security-Policy rejecting patched content. Neither is handled automatically yet.
:::
