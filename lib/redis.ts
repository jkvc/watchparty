/**
 * Redis access for watchparty.
 *
 * Two kinds of clients:
 *   - `getRedis()` — a shared, lazily-created connection for ordinary commands
 *     (GET/SET/HSET/PUBLISH/EXPIRE). Cached on `globalThis` so Next.js dev HMR
 *     doesn't leak a new connection on every reload.
 *   - `createSubscriber()` — a *dedicated* connection per subscriber. A Redis
 *     connection in subscribe mode can't issue normal commands, and each SSE
 *     client needs its own so unsubscribing one doesn't starve the others.
 *
 * The `REDIS_URL` may be shared with other apps, so every key this app writes is
 * namespaced under `wp:` (see `lib/sync.ts` and `lib/room-server.ts`).
 */

import Redis from 'ioredis';

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set');
  return url;
}

const globalForRedis = globalThis as typeof globalThis & { __wpRedis?: Redis };

/** Shared connection for commands and publishing. */
export function getRedis(): Redis {
  return (globalForRedis.__wpRedis ??= new Redis(redisUrl()));
}

/** Fresh connection for a single pub/sub subscriber. Caller must `.quit()`. */
export function createSubscriber(): Redis {
  return new Redis(redisUrl());
}
