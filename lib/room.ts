/**
 * Pure domain logic for a watch-party room. No I/O, no Date.now(), no Redis —
 * every function is deterministic given its inputs, so it's fully unit-testable
 * and safe to run on both the server and the client.
 *
 * The single source of truth for *position* is the `video` scalar anchor:
 * "at server time `at`, the video was at `value` seconds, advancing at
 * `motion.ratePerMs` seconds-per-millisecond." Play/pause *intent* is tracked
 * alongside it (see `PlaybackState`). There is no room-wide readiness gate: a
 * viewer who stalls (ad / buffering) simply self-heals to the live position
 * when they recover, so one viewer never freezes the room.
 */

import { evaluateScalar } from '@syncframe/core/server';
import type { Anchor, ScalarMotion } from '@syncframe/core/server';

export type VideoAnchor = Anchor<number, ScalarMotion>;

// ─── Constants ───────────────────────────────────────────────────────────────

/** Channel id for the playback-position anchor in the core store. */
export const VIDEO_CHANNEL = 'video';

/** Playing rate: 1 second of video per 1000ms of real time. */
export const PLAY_RATE_PER_MS = 1 / 1000;

/** Sliding room TTL: one week of inactivity. */
export const ROOM_TTL_SECONDS = 7 * 24 * 60 * 60;

export const ROOM_ID_LENGTH = 4;
/** Alphanumeric, upper-case. 36^4 ≈ 1.68M room codes. */
export const ROOM_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * A client whose last heartbeat is older than this is considered gone — it stops
 * counting toward the viewer total.
 */
export const CLIENT_STALE_MS = 15_000;

/**
 * When a new video is loaded, anchor playback this far in the future so every
 * viewer has a moment to buffer before position 0 — nobody starts already
 * behind. `positionAt` clamps to 0 until the scheduled start is reached.
 */
export const SCHEDULED_START_LEAD_MS = 1_800;

/**
 * How far a client-authored control timestamp may sit from the server's own
 * clock before we distrust it. Controls carry the acting client's `serverNow()`
 * so the resulting anchor matches what that client already applied optimistically
 * (eliminating the ~one-RTT offset a server re-stamp would introduce). The clamp
 * bounds abuse/clock-bugs: a client can shift the shared timeline by at most this.
 */
export const MAX_CONTROL_SKEW_MS = 3_000;

// ─── Room ids ────────────────────────────────────────────────────────────────

export function generateRoomId(rng: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < ROOM_ID_LENGTH; i++) {
    id += ROOM_ID_ALPHABET[Math.floor(rng() * ROOM_ID_ALPHABET.length)];
  }
  return id;
}

export function normalizeRoomId(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidRoomId(raw: string): boolean {
  const id = normalizeRoomId(raw);
  return id.length === ROOM_ID_LENGTH && [...id].every((c) => ROOM_ID_ALPHABET.includes(c));
}

// ─── YouTube URL parsing ─────────────────────────────────────────────────────

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set([
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const YT_PATH = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/;

/**
 * Extract an 11-char YouTube video id from a pasted URL or bare id.
 * Returns `null` if the input isn't a recognizable YouTube reference.
 */
export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (YT_ID.test(s)) return s;

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return YT_ID.test(id) ? id : null;
  }
  if (YT_HOSTS.has(host) || YT_HOSTS.has(url.hostname)) {
    if (url.pathname === '/watch') {
      const v = url.searchParams.get('v');
      return v && YT_ID.test(v) ? v : null;
    }
    const m = url.pathname.match(YT_PATH);
    if (m) return m[1];
  }
  return null;
}

// ─── Scalar anchors ──────────────────────────────────────────────────────────

export function pausedAnchor(now: number, positionSec: number): VideoAnchor {
  return { at: now, value: Math.max(0, positionSec), motion: { kind: 'scalar', ratePerMs: 0 } };
}

export function playingAnchor(now: number, positionSec: number): VideoAnchor {
  return {
    at: now,
    value: Math.max(0, positionSec),
    motion: { kind: 'scalar', ratePerMs: PLAY_RATE_PER_MS },
  };
}

export function isPlayingAnchor(anchor: VideoAnchor): boolean {
  return anchor.motion.ratePerMs !== 0;
}

/** Current video position (seconds) implied by the anchor at server time `now`. */
export function positionAt(anchor: VideoAnchor, now: number): number {
  return Math.max(0, evaluateScalar(anchor, now));
}

// ─── Playback state + control reducer ────────────────────────────────────────

export interface PlaybackState {
  /** Whether the room intends to be playing — pure play/pause intent. */
  intentPlaying: boolean;
  /** Effective position anchor — the single source of truth for where we are. */
  anchor: VideoAnchor;
  /** Currently loaded YouTube video id, or null if none. */
  videoId: string | null;
}

export type ControlAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; positionSec: number }
  | { type: 'load'; videoId: string };

export function isControlAction(x: unknown): x is ControlAction {
  if (!x || typeof x !== 'object') return false;
  const a = x as Record<string, unknown>;
  switch (a.type) {
    case 'play':
    case 'pause':
      return true;
    case 'seek':
      return typeof a.positionSec === 'number' && Number.isFinite(a.positionSec);
    case 'load':
      return typeof a.videoId === 'string' && a.videoId.length > 0;
    default:
      return false;
  }
}

/**
 * Derive the effective position anchor from a baseline anchor (which carries the
 * desired position) plus the room's play intent. When intent is to play the
 * anchor advances; otherwise it's frozen at the baseline's current position.
 * Because the baseline position is read at `now`, a frozen anchor resumes
 * exactly where it stopped — no jump.
 */
export function deriveEffectiveAnchor(
  baseline: VideoAnchor,
  intentPlaying: boolean,
  now: number,
): VideoAnchor {
  const pos = positionAt(baseline, now);
  return intentPlaying ? playingAnchor(now, pos) : pausedAnchor(now, pos);
}

/**
 * Clamp a client-authored control timestamp into a trusted window around the
 * server's clock. A finite stamp within `maxSkewMs` is used as-is so the stored
 * anchor matches the client's optimistic one; anything further (or non-finite)
 * is pulled to the nearest bound, capping how far a bad client can move the
 * shared timeline.
 */
export function clampStamp(
  clientAtMs: number,
  serverNowMs: number,
  maxSkewMs: number = MAX_CONTROL_SKEW_MS,
): number {
  if (!Number.isFinite(clientAtMs)) return serverNowMs;
  return Math.min(Math.max(clientAtMs, serverNowMs - maxSkewMs), serverNowMs + maxSkewMs);
}

/** Apply a user control action, producing the next playback state. */
export function applyControl(state: PlaybackState, action: ControlAction, now: number): PlaybackState {
  switch (action.type) {
    case 'play':
      return {
        ...state,
        intentPlaying: true,
        anchor: deriveEffectiveAnchor(state.anchor, true, now),
      };
    case 'pause':
      return {
        ...state,
        intentPlaying: false,
        anchor: deriveEffectiveAnchor(state.anchor, false, now),
      };
    case 'seek':
      // Override position; preserve the current play/pause intent.
      return {
        ...state,
        anchor: deriveEffectiveAnchor(pausedAnchor(now, action.positionSec), state.intentPlaying, now),
      };
    case 'load':
      // Start playing, but anchored slightly in the future so every viewer can
      // buffer to position 0 before it advances.
      return {
        intentPlaying: true,
        videoId: action.videoId,
        anchor: playingAnchor(now + SCHEDULED_START_LEAD_MS, 0),
      };
  }
}

// ─── Presence ────────────────────────────────────────────────────────────────

export interface ClientStatus {
  /** Server time of the client's last heartbeat. */
  lastSeen: number;
}

/** Count viewers whose heartbeat is still fresh. */
export function countActiveViewers(clients: Record<string, ClientStatus>, now: number): number {
  let viewers = 0;
  for (const c of Object.values(clients)) {
    if (now - c.lastSeen <= CLIENT_STALE_MS) viewers++;
  }
  return viewers;
}
