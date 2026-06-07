import { describe, it, expect } from 'vitest';
import {
  classifyCapture,
  canSeek,
  scheduledStartDelayMs,
  resetTolerance,
  nextTolerance,
  effectiveTolerance,
  compensatedTarget,
  anchorAgrees,
  reconcileOptimistic,
  endHoldPosition,
  isNearEnd,
  resolveEndPosition,
  clampTargetToDuration,
  TOL_BASE_S,
  TOL_MAX_S,
  TOL_GROW_S,
  SHORT_VIDEO_TOL_MULT,
  END_HOLD_OFFSET_S,
} from '../sync-engine';
import { playingAnchor, pausedAnchor } from '../room';

describe('end-of-video helpers', () => {
  it('parks slightly before the clip end', () => {
    expect(endHoldPosition(212)).toBeCloseTo(212 - END_HOLD_OFFSET_S, 6);
    expect(endHoldPosition(0)).toBe(0);
  });

  it('ignores a bogus zero at ENDED when the last sample was near the end', () => {
    expect(resolveEndPosition(0, 120, 119.5)).toBeCloseTo(119.9, 6);
  });

  it('falls back to the last sample when duration is not yet known', () => {
    expect(resolveEndPosition(0, 0, 90.09)).toBeCloseTo(90.09, 6);
  });

  it('trusts a normal end position', () => {
    expect(resolveEndPosition(119.8, 120, 119.7)).toBeCloseTo(119.8, 6);
  });

  it('clamps follower targets to the hold frame', () => {
    expect(clampTargetToDuration(500, 120)).toBeCloseTo(119.9, 6);
    expect(clampTargetToDuration(50, 120)).toBe(50);
    expect(clampTargetToDuration(50, 0)).toBe(50);
  });

  it('treats a position within the margin of the end as finished', () => {
    // Real case: anchor parked at 89.841 on a 90s clip must count as ended.
    expect(isNearEnd(89.841, 90)).toBe(true);
    expect(isNearEnd(90, 90)).toBe(true);
    expect(isNearEnd(85, 90)).toBe(false);
    expect(isNearEnd(50, 0)).toBe(false); // unknown duration
  });
});

describe('classifyCapture', () => {
  it('returns none when the playhead advances as expected while playing', () => {
    // 1s elapsed at 1x, position moved ~1s — normal playback, not a seek.
    expect(classifyCapture(10, 11, 1, 'playing', 'playing')).toEqual({ kind: 'none' });
  });

  it('detects a forward seek as a position jump beyond playback', () => {
    const e = classifyCapture(10, 40, 1, 'playing', 'playing');
    expect(e.kind).toBe('seek');
    expect(e.positionSec).toBe(40);
  });

  it('detects a backward seek', () => {
    const e = classifyCapture(100, 30, 1, 'playing', 'playing');
    expect(e).toEqual({ kind: 'seek', positionSec: 30 });
  });

  it('does not treat a small drift while paused as a seek', () => {
    expect(classifyCapture(50, 50.1, 0.5, 'paused', 'paused')).toEqual({ kind: 'none' });
  });

  it('classifies a transition into playing as play', () => {
    expect(classifyCapture(50, 50, 0.1, 'paused', 'playing')).toEqual({ kind: 'play' });
  });

  it('does NOT treat paused -> buffering as a play (a paused-frame correction seek buffers)', () => {
    // A follower seeking back to the paused frame momentarily buffers; reading
    // that as a play would broadcast a phantom play and un-pause the room. The
    // real play press is captured one tick later at buffering -> playing.
    expect(classifyCapture(50, 50, 0.1, 'paused', 'buffering')).toEqual({ kind: 'none' });
  });

  it('classifies a cued -> playing start as play', () => {
    expect(classifyCapture(0, 0, 0.1, 'other', 'playing')).toEqual({ kind: 'play' });
  });

  it('does not treat a mid-playback rebuffer recovery as a fresh play', () => {
    // prevPhase is the last non-buffering phase (caller freezes buffering), so a
    // playing→buffering→playing recovery reads as playing→playing = none.
    expect(classifyCapture(50, 50.1, 0.1, 'playing', 'playing')).toEqual({ kind: 'none' });
  });

  it('classifies playing -> paused as pause', () => {
    expect(classifyCapture(50, 50, 0.1, 'playing', 'paused')).toEqual({ kind: 'pause' });
  });

  it('prioritizes a seek over the play/pause flicker a scrub produces', () => {
    // Scrub while playing: state momentarily reads paused AND the position jumps.
    const e = classifyCapture(10, 80, 0.1, 'playing', 'paused');
    expect(e.kind).toBe('seek');
    expect(e.positionSec).toBe(80);
  });

  it('treats buffering as none (transient, not a user action)', () => {
    expect(classifyCapture(50, 50, 0.1, 'playing', 'buffering')).toEqual({ kind: 'none' });
  });
});

describe('canSeek', () => {
  it('forbids seeking while buffering', () => {
    expect(canSeek('buffering')).toBe(false);
  });

  it('allows seeking in every settled phase', () => {
    expect(canSeek('playing')).toBe(true);
    expect(canSeek('paused')).toBe(true);
    expect(canSeek('other')).toBe(true);
  });
});

describe('scheduledStartDelayMs', () => {
  it('returns the lead-adjusted delay for a future start', () => {
    // Start 2000ms out, 200ms lead → fire play in 1800ms.
    expect(scheduledStartDelayMs(5_000, 3_000, 200)).toBe(1_800);
  });

  it('is non-positive once the start (minus lead) has arrived', () => {
    expect(scheduledStartDelayMs(3_100, 3_000, 200)).toBeLessThanOrEqual(0);
    expect(scheduledStartDelayMs(3_000, 3_000, 200)).toBe(-200);
  });
});

describe('adaptive tolerance', () => {
  it('starts at the base tolerance', () => {
    expect(resetTolerance()).toBe(TOL_BASE_S);
  });

  it('grows on a correction and holds steady otherwise', () => {
    expect(nextTolerance(TOL_BASE_S, false)).toBe(TOL_BASE_S);
    expect(nextTolerance(TOL_BASE_S, true)).toBeCloseTo(TOL_BASE_S + TOL_GROW_S, 6);
  });

  it('caps at the maximum after repeated corrections', () => {
    let tol = TOL_BASE_S;
    for (let i = 0; i < 100; i++) tol = nextTolerance(tol, true);
    expect(tol).toBe(TOL_MAX_S);
  });

  it('loosens tolerance for short clips only', () => {
    expect(effectiveTolerance(0.4, 600)).toBeCloseTo(0.4, 6);
    expect(effectiveTolerance(0.4, 30)).toBeCloseTo(0.4 * SHORT_VIDEO_TOL_MULT, 6);
    // Unknown duration (0) is treated as a normal-length clip.
    expect(effectiveTolerance(0.4, 0)).toBeCloseTo(0.4, 6);
  });
});

describe('compensatedTarget', () => {
  const base = {
    rawTarget: 100,
    curPos: 90.5,
    lastSeekTarget: 90,
    lastSeekAtMs: 1_000,
    nowMs: 2_000,
    ratePerMs: 1 / 1000,
    calibrated: true,
  };

  it('returns the raw target before calibration', () => {
    expect(compensatedTarget({ ...base, calibrated: false })).toBe(100);
  });

  it('subtracts the measured seek-latency error when the player lags', () => {
    // Predicted = 90 + 1000ms*(1/1000) = 91. Actual playhead is at 90.5, so the
    // player is 0.5s behind prediction → push the new target 0.5s forward.
    const out = compensatedTarget({ ...base, curPos: 90.5 });
    expect(out).toBeCloseTo(100.5, 6);
  });

  it('ignores an implausibly large error', () => {
    // Player reports 0 (e.g. just reloaded) — predicted 91, err -91, beyond cap.
    expect(compensatedTarget({ ...base, curPos: 0 })).toBe(100);
  });
});

describe('anchorAgrees', () => {
  it('is true for two playing anchors at the same position', () => {
    const a = playingAnchor(1_000, 50);
    const b = playingAnchor(1_200, 50.2); // 200ms later, ~50.2s — same timeline
    expect(anchorAgrees(a, b, 5_000, 0.5)).toBe(true);
  });

  it('is false when one is playing and the other paused', () => {
    const a = playingAnchor(1_000, 50);
    const b = pausedAnchor(1_000, 50);
    expect(anchorAgrees(a, b, 1_000, 0.5)).toBe(false);
  });

  it('is false when positions differ beyond tolerance', () => {
    const a = pausedAnchor(1_000, 50);
    const b = pausedAnchor(1_000, 55);
    expect(anchorAgrees(a, b, 1_000, 0.5)).toBe(false);
  });
});

describe('reconcileOptimistic', () => {
  const opt = pausedAnchor(1_000, 42);
  const snap = pausedAnchor(1_000, 10);

  it('uses the optimistic anchor while active', () => {
    expect(reconcileOptimistic(opt, snap, true)).toBe(opt);
  });

  it('falls back to the snapshot once inactive', () => {
    expect(reconcileOptimistic(opt, snap, false)).toBe(snap);
  });

  it('uses the snapshot when there is no optimistic anchor', () => {
    expect(reconcileOptimistic(null, snap, true)).toBe(snap);
  });
});
