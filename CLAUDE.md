# CLAUDE.md

Guidance for AI assistants working in this repo.

## Project Overview

**watchparty** — a YouTube watch-party web app. Anyone with a 4-character room code can join, paste a YouTube link, and the whole room stays in sync (play / pause / scrub). Built on Next.js and the [`@syncframe`](https://www.npmjs.com/package/@syncframe/core) anchor-based sync protocol, with Redis for room state, pub/sub fan-out, presence, and TTL.

## Important Rules

### 1. Package Manager
This project uses **pnpm**. Never use `npm` or `yarn`.

### 2. Build Commands Must Use a Separate Directory
If you need a verification build, use the isolated output dir so it never clobbers a running `next dev`:

```bash
CHECK_BUILD=1 pnpm run build   # writes to .next-check instead of .next
```

See `next.config.ts`.

### 3. Never Commit or Push Without Explicit Permission
You are **never allowed** to commit or push unless the user explicitly tells you to in a **separate message**. Never use `--no-verify` — always let the pre-push hook run.

### 4. Shared Redis — Always Namespace Under `wp:`
The `REDIS_URL` may point at a Redis instance shared with other apps (e.g. syncframe, which uses the `syncframe:` prefix). **Every key this app writes must live under the `wp:` prefix.** The `SyncServer` is wired with `prefix: 'wp'` and all direct keys (`lib/room-server.ts`) use `wpKey()`. Never write an un-prefixed key.

### 5. Sync Protocol Comes From npm
Consume `@syncframe/core` and `@syncframe/redis` as published packages — never import source across repos or vendor the code. Server-only code imports from `@syncframe/core/server`; client components import hooks from `@syncframe/core/react`.

### 6. Domain Logic Is Pure and Tested
All room math (id generation, URL parsing, the playback-intent reducer, presence counting, and the effective-anchor derivation) lives in `lib/room.ts`, and the client follower engine (native-input classification, adaptive tolerance, seek-latency compensation, optimistic reconciliation) in `lib/sync-engine.ts`. Both are pure functions with no I/O, covered by `lib/__tests__/`. Practice TDD here — write the failing test first.

### 7. Testing
Tests live in `lib/__tests__/` (and `app/__tests__/`). Run with `pnpm test` (vitest). The pre-push hook runs type-check, lint, and test in parallel, then an isolated build.

### 8. Track Tech Debt
Known shortcuts and deferred work go in [`TECH_DEBT.md`](TECH_DEBT.md). Record every conscious shortcut; delete entries once resolved.

### 9. Prose Line Wrapping
Do **not** hard-wrap paragraphs in Markdown. Write each paragraph / list item as a single unwrapped line. Blank lines still separate blocks.

## Architecture (one-screen tour)

```
lib/
  room.ts         Pure domain logic (no I/O). The tested core.
  sync-engine.ts  Pure client follower math (capture / tolerance / compensation).
  redis.ts        ioredis singletons (getRedis / createSubscriber).
  sync.ts         SyncServer wired with RedisStore/RedisTransport, prefix 'wp'.
  room-server.ts  Clients map, viewer-count recompute + publish, sliding TTL.
app/
  page.tsx                 Entrance: create room / join by code.
  room/[id]/page.tsx       Room shell (server) — 404s unknown rooms.
  room/[id]/room-client.tsx  YT IFrame player (native controls) + capture/correction loops.
  api/
    clock/         Authoritative server time for clock sync.
    room/          create (POST), exists (GET /[id]), control, presence,
                   stream (SSE snapshot fan-out).
```

The single source of truth for playback position is the **`video` anchor** (a scalar anchor: `value` = seconds, `ratePerMs` = 0 paused / `1/1000` playing); play/pause *intent* and the viewer count live in `meta`. The room is **native-controls-only** and has **no readiness barrier** — a viewer who stalls (ad/buffering) self-heals to the live position when they recover. See [`notes/2026-06-06-sync-design.md`](notes/2026-06-06-sync-design.md) for the full design rationale.
