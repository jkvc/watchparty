/**
 * Wires the Redis adapters from @syncframe/redis into a core SyncServer.
 *
 * `SyncServer` comes from core's `/server` entry (React-free), so this
 * server-only module never pulls hooks into a client bundle.
 *
 * The `wp` prefix namespaces every core key/channel (`wp:<room>:anchor:video`,
 * `wp:<room>:meta`, `wp:<room>:updates`, …) so this app coexists with anything
 * else sharing the same Redis.
 */

import { SyncServer } from '@syncframe/core/server';
import { RedisStore, RedisTransport } from '@syncframe/redis';
import { getRedis, createSubscriber } from '@/lib/redis';

/** Shared key/channel namespace for everything watchparty writes to Redis. */
export const WP_PREFIX = 'wp';

const globalForSync = globalThis as typeof globalThis & { __wpSyncServer?: SyncServer };

export function getSyncServer(): SyncServer {
  return (globalForSync.__wpSyncServer ??= new SyncServer({
    store: new RedisStore({ redis: getRedis(), prefix: WP_PREFIX }),
    transport: new RedisTransport({ redis: getRedis(), createSubscriber, prefix: WP_PREFIX }),
  }));
}
