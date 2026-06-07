import { describe, it, expect } from 'vitest';
import {
  ROOM_ID_ALPHABET,
  ROOM_ID_LENGTH,
  PLAY_RATE_PER_MS,
  CLIENT_STALE_MS,
  SCHEDULED_START_LEAD_MS,
  generateRoomId,
  normalizeRoomId,
  isValidRoomId,
  parseYouTubeId,
  pausedAnchor,
  playingAnchor,
  isPlayingAnchor,
  positionAt,
  deriveEffectiveAnchor,
  applyControl,
  clampStamp,
  countActiveViewers,
  isControlAction,
  MAX_CONTROL_SKEW_MS,
  type PlaybackState,
  type ClientStatus,
} from '@/lib/room';

describe('room id', () => {
  it('generates a 4-char id from the alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateRoomId();
      expect(id).toHaveLength(ROOM_ID_LENGTH);
      expect([...id].every((c) => ROOM_ID_ALPHABET.includes(c))).toBe(true);
    }
  });

  it('is deterministic given a seeded rng', () => {
    const seq = [0, 0.99, 0.5, 0.25];
    let i = 0;
    const rng = () => seq[i++];
    const id = generateRoomId(rng);
    expect(id).toHaveLength(4);
    expect(id[0]).toBe(ROOM_ID_ALPHABET[0]);
    expect(id[1]).toBe(ROOM_ID_ALPHABET[ROOM_ID_ALPHABET.length - 1]);
  });

  it('normalizes to upper case and trims', () => {
    expect(normalizeRoomId('  ab12 ')).toBe('AB12');
  });

  it('validates length and alphabet', () => {
    expect(isValidRoomId('AB12')).toBe(true);
    expect(isValidRoomId('ab12')).toBe(true); // case-insensitive
    expect(isValidRoomId('ABC')).toBe(false); // too short
    expect(isValidRoomId('ABCDE')).toBe(false); // too long
    expect(isValidRoomId('AB-2')).toBe(false); // bad char
    expect(isValidRoomId('')).toBe(false);
  });
});

describe('parseYouTubeId', () => {
  const ID = 'dQw4w9WgXcQ';

  it('parses standard watch URLs', () => {
    expect(parseYouTubeId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(parseYouTubeId(`https://youtube.com/watch?v=${ID}&t=42s`)).toBe(ID);
    expect(parseYouTubeId(`http://m.youtube.com/watch?v=${ID}`)).toBe(ID);
  });

  it('parses short youtu.be links', () => {
    expect(parseYouTubeId(`https://youtu.be/${ID}`)).toBe(ID);
    expect(parseYouTubeId(`https://youtu.be/${ID}?t=10`)).toBe(ID);
  });

  it('parses shorts, embed, live, /v/ paths', () => {
    expect(parseYouTubeId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
    expect(parseYouTubeId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
    expect(parseYouTubeId(`https://www.youtube.com/live/${ID}`)).toBe(ID);
    expect(parseYouTubeId(`https://www.youtube.com/v/${ID}`)).toBe(ID);
  });

  it('parses the privacy-enhanced nocookie host', () => {
    expect(parseYouTubeId(`https://www.youtube-nocookie.com/embed/${ID}`)).toBe(ID);
  });

  it('accepts a bare 11-char id', () => {
    expect(parseYouTubeId(ID)).toBe(ID);
    expect(parseYouTubeId(`  ${ID}  `)).toBe(ID);
  });

  it('rejects junk and non-youtube URLs', () => {
    expect(parseYouTubeId('')).toBeNull();
    expect(parseYouTubeId('hello world')).toBeNull();
    expect(parseYouTubeId('https://vimeo.com/12345')).toBeNull();
    expect(parseYouTubeId('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(parseYouTubeId('https://www.youtube.com/')).toBeNull();
  });
});

describe('anchors', () => {
  it('paused anchor does not advance and clamps at 0', () => {
    const a = pausedAnchor(1000, 30);
    expect(isPlayingAnchor(a)).toBe(false);
    expect(positionAt(a, 1000)).toBe(30);
    expect(positionAt(a, 999_999)).toBe(30);
    expect(positionAt(pausedAnchor(0, -5), 0)).toBe(0);
  });

  it('playing anchor advances at 1s per 1000ms', () => {
    const a = playingAnchor(1000, 10);
    expect(isPlayingAnchor(a)).toBe(true);
    expect(positionAt(a, 1000)).toBe(10);
    expect(positionAt(a, 2000)).toBeCloseTo(11, 9);
    expect(positionAt(a, 6000)).toBeCloseTo(15, 9);
    expect(PLAY_RATE_PER_MS).toBeCloseTo(1 / 1000, 12);
  });
});

describe('deriveEffectiveAnchor', () => {
  it('plays from the baseline position when intent=playing', () => {
    const baseline = pausedAnchor(5000, 42);
    const eff = deriveEffectiveAnchor(baseline, true, 5000);
    expect(isPlayingAnchor(eff)).toBe(true);
    expect(positionAt(eff, 5000)).toBe(42);
  });

  it('freezes at the live position when intent=paused', () => {
    const baseline = playingAnchor(0, 0); // would be at 3s by now=3000
    const eff = deriveEffectiveAnchor(baseline, false, 3000);
    expect(isPlayingAnchor(eff)).toBe(false);
    expect(positionAt(eff, 3000)).toBeCloseTo(3, 9);
    expect(positionAt(eff, 99_999)).toBeCloseTo(3, 9); // stays frozen
  });
});

describe('applyControl', () => {
  const base = (): PlaybackState => ({
    intentPlaying: false,
    anchor: pausedAnchor(0, 0),
    videoId: null,
  });

  it('play starts advancing from the current position', () => {
    const s = applyControl({ ...base(), anchor: pausedAnchor(0, 20) }, { type: 'play' }, 1000);
    expect(s.intentPlaying).toBe(true);
    expect(isPlayingAnchor(s.anchor)).toBe(true);
    expect(positionAt(s.anchor, 1000)).toBe(20);
  });

  it('pause freezes at the live position', () => {
    const playing: PlaybackState = { intentPlaying: true, anchor: playingAnchor(0, 0), videoId: 'x' };
    const s = applyControl(playing, { type: 'pause' }, 4000);
    expect(s.intentPlaying).toBe(false);
    expect(isPlayingAnchor(s.anchor)).toBe(false);
    expect(positionAt(s.anchor, 4000)).toBeCloseTo(4, 9);
  });

  it('pause with positionSec parks at an explicit frame (end-of-video)', () => {
    const playing: PlaybackState = { intentPlaying: true, anchor: playingAnchor(0, 0), videoId: 'x' };
    const s = applyControl(playing, { type: 'pause', positionSec: 89.9 }, 90_000);
    expect(s.intentPlaying).toBe(false);
    expect(positionAt(s.anchor, 90_000)).toBeCloseTo(89.9, 6);
    expect(positionAt(s.anchor, 99_999)).toBeCloseTo(89.9, 6);
  });

  it('seek jumps to the target and keeps the play/pause state', () => {
    const playing: PlaybackState = { intentPlaying: true, anchor: playingAnchor(0, 0), videoId: 'x' };
    const s = applyControl(playing, { type: 'seek', positionSec: 100 }, 4000);
    expect(s.intentPlaying).toBe(true);
    expect(isPlayingAnchor(s.anchor)).toBe(true);
    expect(positionAt(s.anchor, 4000)).toBe(100);

    const paused = base();
    const s2 = applyControl(paused, { type: 'seek', positionSec: 55 }, 4000);
    expect(s2.intentPlaying).toBe(false);
    expect(isPlayingAnchor(s2.anchor)).toBe(false);
    expect(positionAt(s2.anchor, 4000)).toBe(55);
  });

  it('load schedules a playing start a short lead in the future', () => {
    const now = 9000;
    const s = applyControl(base(), { type: 'load', videoId: 'abcDEF12345' }, now);
    expect(s.videoId).toBe('abcDEF12345');
    expect(s.intentPlaying).toBe(true);
    expect(isPlayingAnchor(s.anchor)).toBe(true);
    // Clamped to 0 until the scheduled start so late loaders can buffer.
    expect(positionAt(s.anchor, now)).toBe(0);
    expect(positionAt(s.anchor, now + SCHEDULED_START_LEAD_MS)).toBe(0);
    // Then it advances normally.
    expect(positionAt(s.anchor, now + SCHEDULED_START_LEAD_MS + 1000)).toBeCloseTo(1, 9);
  });
});

describe('clampStamp', () => {
  const serverNow = 1_000_000;

  it('trusts a client stamp within the skew window (so the anchor matches optimistic)', () => {
    expect(clampStamp(serverNow - 120, serverNow)).toBe(serverNow - 120);
    expect(clampStamp(serverNow + 50, serverNow)).toBe(serverNow + 50);
  });

  it('pulls an out-of-window stamp to the nearest bound', () => {
    expect(clampStamp(serverNow - 10_000, serverNow)).toBe(serverNow - MAX_CONTROL_SKEW_MS);
    expect(clampStamp(serverNow + 10_000, serverNow)).toBe(serverNow + MAX_CONTROL_SKEW_MS);
  });

  it('falls back to the server clock for a non-finite stamp', () => {
    expect(clampStamp(NaN, serverNow)).toBe(serverNow);
    expect(clampStamp(Infinity, serverNow)).toBe(serverNow);
  });
});

describe('countActiveViewers', () => {
  const now = 100_000;
  const seen = (lastSeen: number): ClientStatus => ({ lastSeen });

  it('counts only viewers with a fresh heartbeat', () => {
    const clients = {
      a: seen(now),
      b: seen(now - CLIENT_STALE_MS - 1), // stale
      c: seen(now - 1000),
    };
    expect(countActiveViewers(clients, now)).toBe(2);
  });

  it('counts a viewer exactly at the staleness boundary', () => {
    expect(countActiveViewers({ a: seen(now - CLIENT_STALE_MS) }, now)).toBe(1);
  });

  it('is zero for an empty room', () => {
    expect(countActiveViewers({}, now)).toBe(0);
  });
});

describe('isControlAction', () => {
  it('accepts well-formed actions', () => {
    expect(isControlAction({ type: 'play' })).toBe(true);
    expect(isControlAction({ type: 'pause' })).toBe(true);
    expect(isControlAction({ type: 'pause', positionSec: 89.9 })).toBe(true);
    expect(isControlAction({ type: 'seek', positionSec: 12 })).toBe(true);
    expect(isControlAction({ type: 'load', videoId: 'abcDEF12345' })).toBe(true);
  });

  it('rejects malformed actions', () => {
    expect(isControlAction(null)).toBe(false);
    expect(isControlAction({})).toBe(false);
    expect(isControlAction({ type: 'nope' })).toBe(false);
    expect(isControlAction({ type: 'seek' })).toBe(false);
    expect(isControlAction({ type: 'seek', positionSec: 'x' })).toBe(false);
    expect(isControlAction({ type: 'load' })).toBe(false);
  });
});
