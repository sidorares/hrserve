---
id: profiles
title: Session profiles
sidebar_label: Session profiles
---

# Session profiles

Every session starts in a fresh browser context. That is usually what you want — right up until reaching the interesting page means logging in or clearing a captcha by hand, and you have to redo it for every session.

A **profile** saves that work.

```bash
npx hrserve ./public --url https://app.example.com/ --save-profile login
#   ...log in in the browser window, then press Ctrl-C to capture...

npx hrserve ./public --url https://app.example.com/ --profile login   # already signed in
npx hrserve profiles                                                  # list what's saved
```

Programmatically:

```javascript
const server = createServer(browser);
await server.serve({ url: "https://app.example.com/", dir: "./dist", profile: "login" });
// ...do more manual steps in the page...
await server.saveProfile("login-with-2fa");
```

## Profiles are immutable snapshots

A profile is one JSON file holding Playwright's `storageState`: cookies, per-origin localStorage and IndexedDB. Sessions **read** profiles and never write back — `saveProfile()` is the only way state is persisted, and it always writes a *new* name.

That single rule is what makes branching trivial:

```
--save-profile A          # fresh; sign in by hand → A
--profile A               # B starts from A
--profile A → save as C   # C starts from A too, concurrently, and adds more
--profile C               # D starts from C
```

Two sessions can run from the same profile **at the same time** without interfering, and starting from `A` gives the same result no matter what `C` did afterwards.

There is no `fork` command, because forking *is* "start from X, save as Y" — a name for a pair of existing operations, not a new capability. Each profile records the `parent` it branched from, shown by `hrserve profiles`; that lineage is descriptive only, since every snapshot is complete on its own.

## Why not a browser profile directory?

Playwright offers two ways to carry browser state, and only one fits hrserve:

| | `storageState` (used here) | `launchPersistentContext(userDataDir)` |
|---|---|---|
| What it is | a JSON **value** | a **directory** on disk |
| Carries | cookies, localStorage, IndexedDB | everything, incl. service worker caches, extensions, WebAuthn |
| Concurrency | any number of sessions from one profile | Chromium locks it — one browser process per profile |
| Branching | copy a small file | copy tens of MB, and only while unused |

hrserve's whole point is running many sessions at once. A user-data directory cannot be shared between two of them, which would kill the branching above — so profiles are snapshots, and the fidelity limit is stated rather than hidden.

**A profile does not capture** sessionStorage, service worker caches, HTTP auth, WebAuthn credentials or browser extensions.

## Two things to know

### A profile is a credential file

It contains live session cookies. Profiles are stored per-user **outside your project** — `$XDG_DATA_HOME/hrserve/profiles/` (default `~/.local/share/hrserve/profiles/`), mode `0600`. Never commit one.

### Profiles are origin-scoped

`storageState` belongs to the origins it was captured on, and hrserve deliberately serves at arbitrary origins. A profile captured on `https://app.example.com` does nothing for a session served at `http://app.hrserve.test/`.

hrserve warns when the profile doesn't cover the URL you're serving, naming both — because the alternative is a silently logged-out page that looks like a bug in the site.

Session cookies also expire; `hrserve profiles` shows `capturedAt` so you can tell a stale profile from a broken one.

## With agent sessions

Sessions started through the [SessionManager or MCP](./agents.md) take a `profile` too, so an agent can work against an authenticated app without ever handling credentials:

```javascript
await manager.start({ name: "feature-a", dir: "~/wt/a", profile: "login" });
await manager.get("feature-a").saveProfile("login-plus-cart");
```
