/**
 * Pure client-side sync engine for the YouTube follower loop. No DOM, no
 * `Date.now()`, no player handle — every function is deterministic given its
 * inputs, so the tricky parts (seek-vs-state disambiguation, adaptive tolerance,
 * seek-latency compensation, optimistic-anchor reconciliation) are unit-testable
 * in isolation. The `room-client` component supplies the player observations and
 * applies the decisions.
 *
 * The model: capture native input by polling the playhead and classifying jumps
 * as seeks; correct drift with a tolerance that *grows* on each correction (so a
 * struggling follower never seek-storms) and a learned seek-latency offset (so
 * corrections land on target).
 */

import { isPlayingAnchor, positionAt, type VideoAnchor } from './room';

/** A coarse playback phase derived from the YouTube player state. */
export type PlayerPhase = 'playing' | 'paused' | 'buffering' | 'other';

/** Playhead jump (s) between samples that we read as a deliberate user seek. */
export const SEEK_JUMP_S = 2;
/** Base drift tolerance (s) before a follower re-seeks while playing. */
export const TOL_BASE_S = 0.4;
/** Tolerance growth (s) per correction — widens to break seek-storm loops. */
export const TOL_GROW_S = 0.2;
/** Tolerance ceiling (s). */
export const TOL_MAX_S = 3;
/** Largest seek-latency error (s) we'll trust and compensate for. */
export const COMP_MAX_S = 3;
/** Clips shorter than this tolerate looser sync (seeking them is jumpy). */
export const SHORT_VIDEO_S = 60;
/** Tolerance multiplier applied to short clips. */
export const SHORT_VIDEO_TOL_MULT = 4;
/**
 * Offset from the clip end when parking on the last frame. YouTube's ENDED state
 * often reports `getCurrentTime() === 0` (especially on mobile), and seeking to
 * exactly `duration` can land past the last decodable frame and show a blank
 * player.
 */
export const END_HOLD_OFFSET_S = 0.1;
/**
 * A paused position within this margin of the clip end is treated as "finished".
 * The exact stored position when a video ends varies (the capture tick fires a
 * fraction of a second before/after the real end, and YouTube rounds), so a
 * generous margin is what makes the ended overlay show reliably on late join.
 */
export const END_NEAR_S = 2;

// ─── End-of-video helpers ────────────────────────────────────────────────────

/** Last holdable frame for a clip of the given duration. */
export function endHoldPosition(durationSec: number): number {
  return durationSec > 0 ? Math.max(0, durationSec - END_HOLD_OFFSET_S) : 0;
}

/** Whether a position is close enough to the clip end to count as finished. */
export function isNearEnd(
  positionSec: number,
  durationSec: number,
  marginSec: number = END_NEAR_S,
): boolean {
  return durationSec > 0 && positionSec >= durationSec - marginSec;
}

/**
 * Resolve a trustworthy end-of-video position. At ENDED, some clients report
 * `curPos === 0` even though playback finished — use the last sample (or the
 * hold frame) instead of broadcasting a seek back to the start.
 */
export function resolveEndPosition(
  curPos: number,
  durationSec: number,
  lastSamplePos: number,
): number {
  if (durationSec > 0) {
    const hold = endHoldPosition(durationSec);
    if (curPos < 1 && lastSamplePos > durationSec * 0.5) return hold;
    return Math.min(Math.max(curPos, 0), hold);
  }
  // Duration not yet known (fresh loadVideoById): ENDED still reports curPos === 0.
  if (curPos < 1 && lastSamplePos > 1) return lastSamplePos;
  return Math.max(0, curPos);
}

/** Clamp a follower target so a playing anchor can't seek past the clip end. */
export function clampTargetToDuration(targetSec: number, durationSec: number): number {
  if (durationSec <= 0) return Math.max(0, targetSec);
  return Math.min(Math.max(0, targetSec), endHoldPosition(durationSec));
}

// ─── Native-input capture ────────────────────────────────────────────────────

export type CaptureKind = 'seek' | 'play' | 'pause' | 'none';
export interface CaptureEvent {
  kind: CaptureKind;
  /** Present for `seek`: the position the user scrubbed to. */
  positionSec?: number;
}

/**
 * Classify what the viewer did between two playhead samples.
 *
 * A position discontinuity (beyond what playback could account for) is a seek
 * and takes priority — it carries its own time, so we never also emit a stray
 * play/pause for the state flicker a scrub produces.
 *
 * `prevPhase` must be the last *non-buffering* phase (the caller freezes it while
 * buffering). That's what disambiguates a real play from a rebuffer: pressing
 * play on a paused video produces `paused -> buffering -> playing`, while a
 * mid-playback rebuffer produces `playing -> buffering -> playing`. With
 * buffering made transparent, the former reads as "left the paused state" (a
 * play) and the latter as "still playing" (nothing).
 *
 * Buffering itself is never a user action — only the eventual transition *into
 * playing* is. We deliberately do NOT treat `paused -> buffering` as a play: a
 * follower correcting to a paused frame seeks (which momentarily buffers), and
 * reading that as a play would broadcast a phantom play and un-pause the room.
 * The real play is still captured one tick later at `buffering -> playing`.
 */
export function classifyCapture(
  prevPos: number,
  curPos: number,
  dtSec: number,
  prevPhase: PlayerPhase,
  curPhase: PlayerPhase,
  seekJumpS: number = SEEK_JUMP_S,
): CaptureEvent {
  const expected = prevPos + (prevPhase === 'playing' ? dtSec : 0);
  if (Math.abs(curPos - expected) > seekJumpS) {
    return { kind: 'seek', positionSec: curPos };
  }
  if (curPhase === 'playing' && prevPhase !== 'playing') return { kind: 'play' };
  if (curPhase === 'paused' && prevPhase === 'playing') return { kind: 'pause' };
  return { kind: 'none' };
}

// ─── Adaptive tolerance ──────────────────────────────────────────────────────

/** The tolerance a fresh anchor starts at (reset on every anchor change). */
export function resetTolerance(): number {
  return TOL_BASE_S;
}

/** Grow the tolerance after a correction; hold it steady otherwise. */
export function nextTolerance(tol: number, didCorrect: boolean): number {
  return didCorrect ? Math.min(tol + TOL_GROW_S, TOL_MAX_S) : tol;
}

/** Effective tolerance for a clip of the given duration (short clips loosen). */
export function effectiveTolerance(tol: number, durationSec: number): number {
  const mult = durationSec > 0 && durationSec < SHORT_VIDEO_S ? SHORT_VIDEO_TOL_MULT : 1;
  return tol * mult;
}

// ─── Seek-latency compensation ───────────────────────────────────────────────

export interface CompensateInput {
  /** The raw target position from the anchor at "now". */
  rawTarget: number;
  /** The player's actual current position. */
  curPos: number;
  /** Position we aimed the previous seek at. */
  lastSeekTarget: number;
  /** Wall time (ms) of the previous seek. */
  lastSeekAtMs: number;
  /** Current wall time (ms). */
  nowMs: number;
  /** Playback rate in seconds-of-video per ms-of-wall-time. */
  ratePerMs: number;
  /** Whether we've landed a seek closely enough to trust the calibration. */
  calibrated: boolean;
}

/**
 * Pre-compensate a seek target for the player's residual seek latency. We
 * predict where the playhead *should* be given the last seek and how long ago it
 * happened; the gap between that and the actual position is the player's
 * intrinsic error, which we subtract from the new target so the seek lands on
 * the live position rather than behind it. Ignored until calibrated and clamped
 * to a sane error window.
 */
export function compensatedTarget(i: CompensateInput): number {
  if (!i.calibrated) return i.rawTarget;
  const predicted = i.lastSeekTarget + (i.nowMs - i.lastSeekAtMs) * i.ratePerMs;
  const err = i.curPos - predicted;
  if (Math.abs(err) >= COMP_MAX_S) return i.rawTarget;
  return i.rawTarget - err;
}

// ─── Buffering-safe seeking ──────────────────────────────────────────────────

/**
 * Whether it's safe to seek the player in this phase. Seeking *into* a buffering
 * player (an ad, a slow load) is dropped on the floor by YouTube and only
 * compounds the stall, so we never issue a seek while buffering — a stalled
 * viewer self-heals to live when its content clock resumes instead. This is a
 * hard invariant: route every `seekTo` through it.
 */
export function canSeek(phase: PlayerPhase): boolean {
  return phase !== 'buffering';
}

// ─── Scheduled synchronized start ────────────────────────────────────────────

/**
 * Milliseconds from now until a future-dated playing start should fire, minus a
 * lead that pre-empts the player's own play latency so everyone lands on the
 * scheduled frame together. A value `<= 0` means "start now". Until the start
 * arrives the follower holds the player paused at 0 rather than playing early
 * and being yanked back, which is what produced the start-of-video stutter.
 */
export function scheduledStartDelayMs(
  startAtMs: number,
  serverNowMs: number,
  leadMs: number,
): number {
  return startAtMs - serverNowMs - leadMs;
}

// ─── Optimistic-anchor reconciliation ────────────────────────────────────────

/**
 * True once the authoritative snapshot anchor has caught up to our optimistic
 * one (same play/pause state and within `tolSec` of the same position), at which
 * point the optimistic override can be dropped.
 */
export function anchorAgrees(
  a: VideoAnchor,
  b: VideoAnchor,
  atMs: number,
  tolSec: number,
): boolean {
  return (
    isPlayingAnchor(a) === isPlayingAnchor(b) &&
    Math.abs(positionAt(a, atMs) - positionAt(b, atMs)) <= tolSec
  );
}

/**
 * Pick which anchor the follower loop should track: the optimistic local anchor
 * while it's still active (applied locally, not yet confirmed by the server),
 * otherwise the authoritative snapshot.
 */
export function reconcileOptimistic(
  optimistic: VideoAnchor | null,
  snapshot: VideoAnchor | null,
  optimisticActive: boolean,
): VideoAnchor | null {
  return optimistic && optimisticActive ? optimistic : snapshot;
}
