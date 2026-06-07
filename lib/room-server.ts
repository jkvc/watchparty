/**
 * Server-side room orchestration: existence, presence (viewer count), and the
 * sliding TTL. This is the only place that touches Redis directly (beyond what
 * the core `SyncServer` manages); all the playback math lives in the pure
 * `lib/room.ts`.
 *
 * Every key written here is namespaced under `wp:` to coexist with anything else
 * sharing the Redis instance.
 */

import { getRedis } from '@/lib/redis';
import { getSyncServer, WP_PREFIX } from '@/lib/sync';
import {
  VIDEO_CHANNEL,
  ROOM_TTL_SECONDS,
  pausedAnchor,
  applyControl,
  clampStamp,
  countActiveViewers,
  generateRoomId,
  type VideoAnchor,
  type PlaybackState,
  type ControlAction,
  type ClientStatus,
} from '@/lib/room';

// ─── Key helpers (all under the wp: namespace) ───────────────────────────────

function roomNs(roomId: string): string {
  return `${WP_PREFIX}:${roomId}`;
}
function existsKey(roomId: string): string {
  return `${roomNs(roomId)}:exists`;
}
function clientsKey(roomId: string): string {
  return `${roomNs(roomId)}:clients`;
}

/** Every Redis key associated with a room — used by the sliding TTL. */
function allRoomKeys(roomId: string): string[] {
  const ns = roomNs(roomId);
  return [
    `${ns}:exists`,
    `${ns}:clients`,
    `${ns}:meta`,
    `${ns}:channels`,
    `${ns}:content`,
    `${ns}:anchor:${VIDEO_CHANNEL}`,
  ];
}

/** Slide every room key's expiry forward to a full TTL. */
export async function touchRoom(roomId: string): Promise<void> {
  const redis = getRedis();
  const pipe = redis.pipeline();
  for (const key of allRoomKeys(roomId)) pipe.expire(key, ROOM_TTL_SECONDS);
  await pipe.exec();
}

// ─── Room lifecycle ──────────────────────────────────────────────────────────

const MAX_ID_ATTEMPTS = 8;

/** Create a fresh room with a unique code. Returns the code, or null on collision exhaustion. */
export async function createRoom(): Promise<string | null> {
  const redis = getRedis();
  const server = getSyncServer();
  const now = Date.now();

  let roomId: string | null = null;
  for (let i = 0; i < MAX_ID_ATTEMPTS; i++) {
    const candidate = generateRoomId();
    // SET NX claims the code atomically so two creators can't grab the same one.
    const ok = await redis.set(existsKey(candidate), '1', 'EX', ROOM_TTL_SECONDS, 'NX');
    if (ok) {
      roomId = candidate;
      break;
    }
  }
  if (!roomId) return null;

  await server.setAnchor(roomId, VIDEO_CHANNEL, pausedAnchor(now, 0));
  await server.patchMeta(roomId, {
    videoId: null,
    intentPlaying: false,
    viewers: 0,
  });
  await touchRoom(roomId);
  return roomId;
}

export async function roomExists(roomId: string): Promise<boolean> {
  return (await getRedis().exists(existsKey(roomId))) === 1;
}

// ─── State load ──────────────────────────────────────────────────────────────

interface LoadedRoom {
  state: PlaybackState;
  meta: Record<string, unknown>;
}

async function loadRoom(roomId: string, now: number): Promise<LoadedRoom> {
  const server = getSyncServer();
  const [anchorRaw, meta] = await Promise.all([
    server.getAnchor(roomId, VIDEO_CHANNEL),
    server.getMeta(roomId),
  ]);
  const state: PlaybackState = {
    intentPlaying: meta.intentPlaying === true,
    videoId: typeof meta.videoId === 'string' ? meta.videoId : null,
    anchor: (anchorRaw as VideoAnchor | null) ?? pausedAnchor(now, 0),
  };
  return { state, meta };
}

/**
 * Garbage-collect a client from the hash after this long without a heartbeat.
 * Deliberately more generous than `CLIENT_STALE_MS` (the presence/gate window in
 * `computeGate`): GC is cleanup, the gate decides liveness. A client aged
 * between the two thresholds is kept in the hash but ignored by the gate.
 */
const CLIENT_GC_MS = 60_000;

/** Read the live clients map, deleting anyone past the GC window. */
async function readClients(roomId: string, now: number): Promise<Record<string, ClientStatus>> {
  const redis = getRedis();
  const raw = await redis.hgetall(clientsKey(roomId));
  const out: Record<string, ClientStatus> = {};
  const dead: string[] = [];
  for (const [id, json] of Object.entries(raw)) {
    try {
      const status = JSON.parse(json) as ClientStatus;
      if (now - status.lastSeen > CLIENT_GC_MS) dead.push(id);
      else out[id] = status;
    } catch {
      dead.push(id);
    }
  }
  if (dead.length) await redis.hdel(clientsKey(roomId), ...dead);
  return out;
}

// ─── Viewer-count recompute + publish ────────────────────────────────────────

/**
 * Recompute the live viewer count and publish if it changed (or `force`). Used
 * after presence changes; explicit control actions publish unconditionally.
 */
async function recomputeViewers(
  roomId: string,
  clients: Record<string, ClientStatus>,
  now: number,
  force: boolean,
): Promise<void> {
  const server = getSyncServer();
  const { meta } = await loadRoom(roomId, now);
  const viewers = countActiveViewers(clients, now);

  await server.patchMeta(roomId, { viewers });
  await touchRoom(roomId);

  if (force || meta.viewers !== viewers) await server.publishUpdate(roomId);
}

// ─── Public operations ───────────────────────────────────────────────────────

/**
 * Apply a play/pause/seek/load control and broadcast.
 *
 * `atClientMs` is the acting client's own `serverNow()` at the moment it acted.
 * We stamp the resulting anchor with that (clamped) time rather than the server's
 * processing time, so the stored/broadcast anchor is identical to the anchor the
 * client already applied optimistically — no ~one-RTT offset between the actor
 * and everyone following the anchor. Server time is still used for presence and
 * TTL bookkeeping.
 */
export async function applyControlAndPublish(
  roomId: string,
  action: ControlAction,
  atClientMs?: number,
): Promise<void> {
  const server = getSyncServer();
  const now = Date.now();
  const stampedAt = clampStamp(atClientMs ?? now, now);
  const clients = await readClients(roomId, now);
  const { state } = await loadRoom(roomId, now);

  const next = applyControl(state, action, stampedAt);

  await server.setAnchor(roomId, VIDEO_CHANNEL, next.anchor);
  await server.patchMeta(roomId, {
    videoId: next.videoId,
    intentPlaying: next.intentPlaying,
    viewers: countActiveViewers(clients, now),
  });
  await touchRoom(roomId);
  await server.publishUpdate(roomId);
}

/** Record a presence heartbeat, then republish if the viewer count changed. */
export async function heartbeatAndPublish(roomId: string, clientId: string): Promise<void> {
  const now = Date.now();
  const clients = await readClients(roomId, now);
  const status: ClientStatus = { lastSeen: now };
  await getRedis().hset(clientsKey(roomId), clientId, JSON.stringify(status));
  clients[clientId] = status;
  await recomputeViewers(roomId, clients, now, false);
}

/** Drop a client (tab close / unload) and republish the viewer count. */
export async function leaveAndPublish(roomId: string, clientId: string): Promise<void> {
  const now = Date.now();
  await getRedis().hdel(clientsKey(roomId), clientId);
  const clients = await readClients(roomId, now);
  await recomputeViewers(roomId, clients, now, true);
}
