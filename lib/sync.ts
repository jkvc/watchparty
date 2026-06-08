/**
 * Wires the Redis adapters from @syncframe/redis into core SyncServer instances.
 *
 * Each watchparty room is a separate namespace on the shared store/transport.
 * The `wp` prefix namespaces every core key/channel (`wp:<room>:anchor:video`,
 * `wp:<room>:meta`, `wp:<room>:updates`, …) so this app coexists with anything
 * else sharing the same Redis.
 */

import { SyncServer } from '@syncframe/core/server';
import { RedisStore, RedisTransport } from '@syncframe/redis';
import { getRedis, createSubscriber } from '@/lib/redis';

/** Shared key/channel namespace for everything watchparty writes to Redis. */
export const WP_PREFIX = 'wp';

const globalForWp = globalThis as typeof globalThis & {
  __wpStore?: RedisStore;
  __wpTransport?: RedisTransport;
  __wpServers?: Map<string, SyncServer>;
};

function getSharedStore(): RedisStore {
  return (globalForWp.__wpStore ??= new RedisStore({ redis: getRedis(), prefix: WP_PREFIX }));
}

function getSharedTransport(): RedisTransport {
  return (globalForWp.__wpTransport ??= new RedisTransport({
    redis: getRedis(),
    createSubscriber,
    prefix: WP_PREFIX,
  }));
}

/** One SyncServer per room code — namespace-bound (@syncframe/core@0.3). */
export function getSyncServerForRoom(roomId: string): SyncServer {
  const map = (globalForWp.__wpServers ??= new Map());
  const existing = map.get(roomId);
  if (existing && typeof existing.ensureAnchor === 'function') return existing;

  const server = new SyncServer({
    store: getSharedStore(),
    transport: getSharedTransport(),
    namespace: roomId,
  });
  map.set(roomId, server);
  return server;
}
