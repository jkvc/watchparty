'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { useServerClock } from '@syncframe/core/react';
import {
  isPlayingAnchor,
  parseYouTubeId,
  pausedAnchor,
  playingAnchor,
  positionAt,
  PLAY_RATE_PER_MS,
  type ControlAction,
  type VideoAnchor,
} from '@/lib/room';
import {
  anchorAgrees,
  canSeek,
  classifyCapture,
  compensatedTarget,
  effectiveTolerance,
  nextTolerance,
  resetTolerance,
  scheduledStartDelayMs,
  type PlayerPhase,
} from '@/lib/sync-engine';
import { loadYouTubeAPI, youtubeErrorMessage, YT_STATE, type YTPlayer } from './youtube';
import { useRoomSnapshot, type RoomSnapshot } from './use-room-snapshot';

// ─── Tuning ──────────────────────────────────────────────────────────────────
// Capture and correction share ONE loop so capture always runs first and the
// follower can never fight a native action it hasn't broadcast yet.
const TICK_MS = 100;
const CORRECTION_COOLDOWN_MS = 1500; // min between playing re-seeks (unless forced)
const PAUSED_TOL_S = 0.3; // position drift tolerated while paused
const AGREE_TOL_S = 0.5; // snapshot/optimistic match window
const CALIBRATE_S = 5; // a seek landing this close enables latency compensation
const PLAY_RETRY_MS = 1200; // wait before falling back to muted autoplay
const HEARTBEAT_MS = 4000; // presence heartbeat cadence
// After WE drive the player (a correction seek / programmatic play-pause / load),
// briefly ignore the matching native capture + drift measurement so the state
// churn (BUFFERING flicker, settling currentTime) isn't mistaken for user input.
// Windows are PER ACTION TYPE: a settling seek must not also swallow a genuine
// pause the viewer makes in the same instant. Short on purpose: a long window
// would swallow a *real* action right after — the old "bounce back" bug.
const SEEK_SETTLE_MS = 700; // a programmatic seek buffers, then settles
const STATE_SETTLE_MS = 400; // a programmatic play/pause transition
const LOAD_SETTLE_MS = 1000; // a fresh video load (settles both seek + state)
// Lead time subtracted from a future-dated start so play fires slightly early
// and pre-empts the player's own play latency — everyone lands together.
const SCHEDULED_PLAY_LEAD_MS = 200;
// An optimistic local anchor (applied the instant the viewer acts) overrides the
// SSE snapshot until the snapshot confirms the action or this safety timeout.
const OPTIMISTIC_MS = 2000;

function phaseOf(state: number): PlayerPhase {
  if (state === YT_STATE.PLAYING) return 'playing';
  if (state === YT_STATE.PAUSED) return 'paused';
  if (state === YT_STATE.BUFFERING) return 'buffering';
  return 'other';
}

function useClientId(): string {
  const ref = useRef<string>('');
  if (!ref.current) {
    if (typeof window !== 'undefined') {
      const key = 'wp-client-id';
      let id = sessionStorage.getItem(key);
      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem(key, id);
      }
      ref.current = id;
    } else {
      ref.current = 'ssr';
    }
  }
  return ref.current;
}

export function RoomClient({ roomId }: { roomId: string }) {
  const router = useRouter();
  const clientId = useClientId();
  const clock = useServerClock('/api/clock');
  const { serverNow } = clock;
  const snapshot = useRoomSnapshot(roomId);

  // Latest snapshot + clock in refs so the intervals don't re-subscribe.
  const snapshotRef = useRef<RoomSnapshot>(snapshot);
  snapshotRef.current = snapshot;
  const serverNowRef = useRef(serverNow);
  serverNowRef.current = serverNow;

  const playerRef = useRef<YTPlayer | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const loadedVideoIdRef = useRef<string | null>(null);

  // Self-command settle windows (per action type) + optimistic anchor.
  const seekSettleUntilRef = useRef(0);
  const stateSettleUntilRef = useRef(0);
  const optimisticRef = useRef<{ anchor: VideoAnchor; until: number } | null>(null);

  // Capture-poll bookkeeping (last observed playhead sample).
  const lastSampleTimeRef = useRef(0);
  const lastSampleAtRef = useRef(0);
  const lastSamplePhaseRef = useRef<PlayerPhase>('other');

  // Correction bookkeeping (adaptive tolerance + seek-latency calibration).
  const tolRef = useRef(resetTolerance());
  const lastCorrectionAtRef = useRef(0);
  const lastSeekTargetRef = useRef(0);
  const lastSeekAtRef = useRef(0);
  const calibratedRef = useRef(false);
  const forceCorrectRef = useRef(false);
  const lastAnchorKeyRef = useRef('');

  // Autoplay fallback.
  const playTriedAtRef = useRef(0);
  const mutedFallbackRef = useRef(false);

  const [joined, setJoined] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [shareUrl, setShareUrl] = useState('');

  useEffect(() => {
    setShareUrl(window.location.href);
  }, []);

  // ─── Stable helpers (read refs; identity safe for effect deps) ─────────────
  /**
   * Ignore the matching native capture + drift for `ms` after we drive the
   * player ourselves. `kind` scopes the suppression: a programmatic seek must
   * not swallow a genuine play/pause the viewer makes in the same window.
   */
  const settle = useCallback((wallNow: number, ms: number, kind: 'seek' | 'state' | 'both') => {
    if (kind === 'seek' || kind === 'both') {
      seekSettleUntilRef.current = Math.max(seekSettleUntilRef.current, wallNow + ms);
    }
    if (kind === 'state' || kind === 'both') {
      stateSettleUntilRef.current = Math.max(stateSettleUntilRef.current, wallNow + ms);
    }
  }, []);

  /** Seek the player, but never while buffering (hard self-heal invariant). */
  const safeSeek = useCallback((player: YTPlayer, pos: number, phase: PlayerPhase): boolean => {
    if (!canSeek(phase)) return false;
    player.seekTo(pos, true);
    return true;
  }, []);

  const setOptimistic = useCallback((anchor: VideoAnchor, wallNow: number) => {
    optimisticRef.current = { anchor, until: wallNow + OPTIMISTIC_MS };
  }, []);

  /** The anchor the follower should track: optimistic override until confirmed. */
  const getEffectiveAnchor = useCallback((serverT: number, wallNow: number): VideoAnchor | null => {
    const snap = snapshotRef.current.anchor;
    const opt = optimisticRef.current;
    if (opt) {
      const expired = wallNow >= opt.until;
      const confirmed = snap != null && anchorAgrees(opt.anchor, snap, serverT, AGREE_TOL_S);
      if (expired || confirmed) {
        optimisticRef.current = null;
        return snap;
      }
      return opt.anchor;
    }
    return snap;
  }, []);

  const sendControl = useCallback(
    async (action: ControlAction) => {
      await fetch('/api/room/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, action }),
      });
    },
    [roomId],
  );
  const sendControlRef = useRef(sendControl);
  sendControlRef.current = sendControl;

  // ─── One ordered loop: capture native input first, then follow the anchor ──
  // Running both in a single tick (capture → return on a captured action →
  // otherwise correct) is what prevents the follower from "correcting" a fresh
  // native scrub/pause back to the stale anchor before it has been broadcast.
  const tick = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    const { meta } = snapshotRef.current;
    const wallNow = Date.now();
    const serverT = serverNowRef.current();

    const state = player.getPlayerState();
    const phase = phaseOf(state);
    const curPos = player.getCurrentTime();

    // 1. Load a newly-selected video.
    if (meta.videoId && meta.videoId !== loadedVideoIdRef.current) {
      loadedVideoIdRef.current = meta.videoId;
      setVideoError(null);
      const anchor = getEffectiveAnchor(serverT, wallNow);
      const startAt = anchor ? positionAt(anchor, serverT) : 0;
      // A future-dated start is cued (not loaded) so it doesn't autoplay early —
      // the scheduled-start hold below releases it on time.
      const futureStart = anchor != null && isPlayingAnchor(anchor) && anchor.at > serverT;
      if (anchor && isPlayingAnchor(anchor) && !futureStart) {
        player.loadVideoById(meta.videoId, startAt);
      } else {
        player.cueVideoById(meta.videoId, startAt);
      }
      lastSampleTimeRef.current = startAt;
      lastSampleAtRef.current = wallNow;
      lastSamplePhaseRef.current = 'buffering';
      tolRef.current = resetTolerance();
      lastSeekTargetRef.current = startAt;
      lastSeekAtRef.current = wallNow;
      lastCorrectionAtRef.current = wallNow;
      calibratedRef.current = false;
      settle(wallNow, LOAD_SETTLE_MS, 'both');
      return;
    }

    // 2. Always advance the playhead sample (even while settling) so the
    //    discontinuity test stays accurate and our own commands never read back
    //    as a jump once the settle window lifts.
    const dt = (wallNow - lastSampleAtRef.current) / 1000;
    const event = classifyCapture(
      lastSampleTimeRef.current,
      curPos,
      dt,
      lastSamplePhaseRef.current,
      phase,
    );
    lastSampleTimeRef.current = curPos;
    lastSampleAtRef.current = wallNow;
    // Keep the last *non-buffering* phase: buffering is transient, and freezing
    // it is what lets classifyCapture tell a real play (paused→buffering→playing)
    // apart from a mid-playback rebuffer (playing→buffering→playing).
    if (phase !== 'buffering') lastSamplePhaseRef.current = phase;

    if (!meta.videoId) return;

    const settlingSeek = wallNow < seekSettleUntilRef.current;
    const settlingState = wallNow < stateSettleUntilRef.current;

    // 3. Capture the viewer's native action and broadcast it. Each kind is
    //    suppressed only while OUR matching command is still settling, so a
    //    settling seek can't swallow a genuine play/pause the viewer makes in
    //    the same instant. A captured action returns immediately so the follower
    //    below never fights it; the optimistic anchor holds until the server
    //    echoes back.
    if (state === YT_STATE.ENDED && meta.intentPlaying) {
      if (!settlingState) {
        setOptimistic(pausedAnchor(serverT, curPos), wallNow);
        void sendControlRef.current({ type: 'pause' });
      }
      return;
    }
    if (event.kind === 'seek') {
      if (!settlingSeek) {
        const pos = event.positionSec ?? curPos;
        setOptimistic(
          meta.intentPlaying ? playingAnchor(serverT, pos) : pausedAnchor(serverT, pos),
          wallNow,
        );
        void sendControlRef.current({ type: 'seek', positionSec: pos });
      }
      return;
    }
    if (event.kind === 'play' && !meta.intentPlaying) {
      if (!settlingState) {
        setOptimistic(playingAnchor(serverT, curPos), wallNow);
        void sendControlRef.current({ type: 'play' });
      }
      return;
    }
    if (event.kind === 'pause' && meta.intentPlaying) {
      if (!settlingState) {
        setOptimistic(pausedAnchor(serverT, curPos), wallNow);
        void sendControlRef.current({ type: 'pause' });
      }
      return;
    }

    // No native action. If a command of ours is still settling, don't correct
    // yet — let the player finish reacting to it.
    if (settlingSeek || settlingState) return;

    // 4. Follow the room anchor (drift correction + play/pause state).
    const anchor = getEffectiveAnchor(serverT, wallNow);
    if (!anchor) return;

    // Reset the tolerance (and force one correction) whenever the anchor changes
    // — i.e. someone issued a control — so we re-tighten after any user action.
    const key = `${anchor.at}|${anchor.value}|${anchor.motion.ratePerMs}`;
    if (key !== lastAnchorKeyRef.current) {
      lastAnchorKeyRef.current = key;
      tolRef.current = resetTolerance();
      forceCorrectRef.current = true;
    }

    const targetPlaying = isPlayingAnchor(anchor);
    const rawTarget = positionAt(anchor, serverT);
    const settled = phase !== 'buffering' && state !== YT_STATE.UNSTARTED;
    const duration = player.getDuration();

    // Scheduled synchronized start: while a playing anchor's start is still in
    // the future, hold the player paused at 0 and release it exactly `lead` ms
    // early — so everyone begins on the same frame instead of playing early and
    // being yanked back (the start-of-video stutter).
    if (targetPlaying && scheduledStartDelayMs(anchor.at, serverT, SCHEDULED_PLAY_LEAD_MS) > 0) {
      if (state === YT_STATE.PLAYING) {
        player.pauseVideo();
        lastSamplePhaseRef.current = 'paused';
        settle(wallNow, STATE_SETTLE_MS, 'state');
      } else if (curPos > 0.5 && safeSeek(player, 0, phase)) {
        lastSampleTimeRef.current = 0;
        lastSampleAtRef.current = wallNow;
        settle(wallNow, SEEK_SETTLE_MS, 'seek');
      }
      return;
    }

    // Drift correction — skipped while buffering so a buffering/ad viewer
    // self-heals to live when it recovers rather than seek-storming.
    if (settled) {
      if (targetPlaying) {
        const tol = effectiveTolerance(tolRef.current, duration);
        const drift = Math.abs(curPos - rawTarget);
        const cooledDown = wallNow - lastCorrectionAtRef.current > CORRECTION_COOLDOWN_MS;
        if (drift > tol && (forceCorrectRef.current || cooledDown)) {
          const target = compensatedTarget({
            rawTarget,
            curPos,
            lastSeekTarget: lastSeekTargetRef.current,
            lastSeekAtMs: lastSeekAtRef.current,
            nowMs: wallNow,
            ratePerMs: PLAY_RATE_PER_MS,
            calibrated: calibratedRef.current,
          });
          if (safeSeek(player, target, phase)) {
            lastSeekTargetRef.current = target;
            lastSeekAtRef.current = wallNow;
            lastCorrectionAtRef.current = wallNow;
            tolRef.current = nextTolerance(tolRef.current, true);
            if (Math.abs(curPos - target) < CALIBRATE_S) calibratedRef.current = true;
            forceCorrectRef.current = false;
            lastSampleTimeRef.current = target;
            lastSampleAtRef.current = wallNow;
            settle(wallNow, SEEK_SETTLE_MS, 'seek');
            return;
          }
        }
        forceCorrectRef.current = false;
      } else if (Math.abs(curPos - rawTarget) > PAUSED_TOL_S && safeSeek(player, rawTarget, phase)) {
        lastSampleTimeRef.current = rawTarget;
        lastSampleAtRef.current = wallNow;
        forceCorrectRef.current = false;
        settle(wallNow, SEEK_SETTLE_MS, 'seek');
        return;
      } else {
        forceCorrectRef.current = false;
      }
    }

    // Follow the play/pause state (with autoplay + muted fallback).
    if (targetPlaying) {
      const playing = state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING;
      if (!playing) {
        if (playTriedAtRef.current === 0) {
          playTriedAtRef.current = wallNow;
          player.playVideo();
          lastSamplePhaseRef.current = 'playing';
          settle(wallNow, STATE_SETTLE_MS, 'state');
        } else if (wallNow - playTriedAtRef.current > PLAY_RETRY_MS) {
          if (!mutedFallbackRef.current) {
            mutedFallbackRef.current = true;
            player.mute();
            setNeedsUnmute(true);
          }
          playTriedAtRef.current = wallNow;
          player.playVideo();
          lastSamplePhaseRef.current = 'playing';
          settle(wallNow, STATE_SETTLE_MS, 'state');
        }
      } else {
        playTriedAtRef.current = 0;
      }
    } else if (state === YT_STATE.PLAYING) {
      // Only force-pause an actually-playing player. A buffering player may be a
      // viewer who just pressed play (the paused→buffering capture above already
      // broadcast it) — re-pausing it here is what made "press play" not stick.
      playTriedAtRef.current = 0;
      player.pauseVideo();
      lastSamplePhaseRef.current = 'paused';
      settle(wallNow, STATE_SETTLE_MS, 'state');
    }
  }, [getEffectiveAnchor, setOptimistic, settle, safeSeek]);
  const tickRef = useRef(tick);
  tickRef.current = tick;

  // ─── Create the player on join ─────────────────────────────────────────────
  useEffect(() => {
    if (!joined || !containerRef.current || playerRef.current) return;
    let cancelled = false;

    loadYouTubeAPI().then((YT) => {
      if (cancelled || !containerRef.current) return;
      const host = document.createElement('div');
      containerRef.current.appendChild(host);
      playerRef.current = new YT.Player(host, {
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 1, // native control bar + scrubber are the only controls
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          iv_load_policy: 3,
        },
        events: {
          onReady: () => setPlayerReady(true),
          onError: (e) => setVideoError(youtubeErrorMessage(e.data)),
          // Immediate reaction to a native state change; the 100ms poll catches
          // scrubs and anything between transitions.
          onStateChange: () => tickRef.current(),
        },
      });
    });

    return () => {
      cancelled = true;
    };
  }, [joined]);

  // ─── Single capture + correction loop ──────────────────────────────────────
  useEffect(() => {
    if (!playerReady) return;
    const loop = setInterval(() => tickRef.current(), TICK_MS);
    return () => clearInterval(loop);
  }, [playerReady]);

  // ─── Presence heartbeat (viewer count) ─────────────────────────────────────
  const sendHeartbeat = useCallback(() => {
    void fetch('/api/room/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, clientId }),
    });
  }, [roomId, clientId]);

  useEffect(() => {
    if (!joined) return;
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, HEARTBEAT_MS);
    return () => clearInterval(interval);
  }, [joined, sendHeartbeat]);

  // ─── Leave on unload ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!joined) return;
    const leave = () => {
      const body = JSON.stringify({ roomId, clientId, leaving: true });
      navigator.sendBeacon?.('/api/room/presence', new Blob([body], { type: 'application/json' }));
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [joined, roomId, clientId]);

  // ─── Handlers ──────────────────────────────────────────────────────────────
  const loadLink = (e: React.FormEvent) => {
    e.preventDefault();
    const videoId = parseYouTubeId(linkInput);
    if (!videoId) {
      setLinkError('That doesn’t look like a YouTube link.');
      return;
    }
    setLinkError(null);
    setLinkInput('');
    void sendControl({ type: 'load', videoId });
  };

  const reloadVideo = () => {
    setVideoError(null);
    loadedVideoIdRef.current = null; // force the correction loop to re-load
  };

  const unmute = () => {
    playerRef.current?.unMute();
    mutedFallbackRef.current = false;
    setNeedsUnmute(false);
  };

  const { meta } = snapshot;
  const synced = clock.sampleCount > 0;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-5">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={() => router.push('/')}
          className="text-lg font-semibold tracking-tight text-neutral-200"
        >
          watch<span className="text-rose-500">party</span>
        </button>
        <div className="flex items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1.5 text-neutral-400">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            {meta.viewers || 1} watching
          </span>
          <button
            onClick={() => setShowShare((s) => !s)}
            className="rounded-lg border border-neutral-800 px-3 py-1.5 font-mono tracking-[0.3em] text-neutral-200 hover:border-neutral-600"
          >
            {roomId}
          </button>
        </div>
      </div>

      {showShare && (
        <div className="mb-4 flex items-center gap-4 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="rounded-lg bg-white p-2">
            {shareUrl && <QRCodeSVG value={shareUrl} size={92} />}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">Invite friends</div>
            <div className="mt-1 truncate text-xs text-neutral-400">{shareUrl}</div>
            <button
              onClick={() => navigator.clipboard?.writeText(shareUrl)}
              className="mt-2 rounded-lg bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700"
            >
              Copy link
            </button>
          </div>
        </div>
      )}

      {/* Video stage — native YouTube controls drive play/pause/scrub */}
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-neutral-800 bg-black">
        <div ref={containerRef} className="h-full w-full" />

        {!joined && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/80">
            <p className="text-sm text-neutral-300">
              {meta.videoId ? 'A video is playing in this room.' : 'No video loaded yet.'}
            </p>
            <button
              onClick={() => setJoined(true)}
              className="rounded-xl bg-rose-500 px-6 py-3 font-medium text-white hover:bg-rose-400"
            >
              Join watch party
            </button>
            <p className="max-w-xs text-center text-xs text-neutral-500">
              We need one tap to start playback in sync (browsers block autoplay otherwise).
            </p>
          </div>
        )}

        {joined && !meta.videoId && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
            Paste a YouTube link below to start.
          </div>
        )}

        {videoError && (
          <div className="absolute inset-x-0 top-0 flex items-center justify-center gap-3 bg-rose-500/90 px-4 py-2 text-center text-sm text-white">
            <span>{videoError}</span>
            <button
              onClick={reloadVideo}
              className="rounded-md bg-black/30 px-2 py-1 text-xs font-medium hover:bg-black/50"
            >
              Reload
            </button>
          </div>
        )}

        {needsUnmute && (
          <button
            onClick={unmute}
            className="absolute right-3 top-3 rounded-lg bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur hover:bg-black/90"
          >
            🔇 Tap to unmute
          </button>
        )}
      </div>

      {/* Load a different video (no native control exists for this) */}
      <form onSubmit={loadLink} className="mt-4 flex gap-2">
        <input
          value={linkInput}
          onChange={(e) => setLinkInput(e.target.value)}
          placeholder="Paste a YouTube link to play something new…"
          className="min-w-0 flex-1 rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2.5 text-sm outline-none focus:border-rose-500"
        />
        <button
          type="submit"
          className="rounded-xl border border-neutral-700 px-4 py-2.5 text-sm font-medium hover:border-neutral-500"
        >
          Load
        </button>
      </form>

      {linkError && <p className="mt-2 text-xs text-rose-400">{linkError}</p>}

      <div className="mt-4 text-center text-[11px] text-neutral-600">
        {synced ? 'Synced to room clock' : 'Syncing clock…'} · Use the player’s own controls — everyone
        stays in sync
      </div>
    </main>
  );
}
