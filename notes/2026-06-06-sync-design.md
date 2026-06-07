# watchparty — sync design (2026-06-06)

The full design rationale for how watchparty keeps every viewer's YouTube player in lockstep. This is the current, authoritative note; it supersedes the earlier kickoff and overhaul drafts.

## Goal

A dead-simple shared YouTube viewing experience. Open the site, create a room (or join one with a 4-character code), paste a YouTube link, and everyone in the room watches the same thing at the same time. Anyone can control playback with the player's own native controls. No accounts, no room directory.

## Why syncframe

Playback position is a textbook scalar drift: "at server time `t`, we were at `p` seconds, advancing at `r` seconds-per-second." That is exactly [`@syncframe/core`](https://www.npmjs.com/package/@syncframe/core)'s `ScalarMotion` anchor. Instead of streaming `currentTime` updates between peers (which jitters and fights the player), we store **one anchor** and let every client evaluate it against an NTP-style synced server clock. Play = rate `1/1000` per ms, pause = rate `0`, seek = a new anchor at the seeked position.

This keeps the wire protocol tiny and makes late joiners trivially correct: read the anchor, evaluate at `serverNow()`, seek there. The Redis-backed store and transport come from [`@syncframe/redis`](https://www.npmjs.com/package/@syncframe/redis); the server clock and React hooks come from `@syncframe/core`. We consume both as published npm packages — never vendored or cross-imported.

## State model

The single source of truth for *position* is the **`video` anchor** (channel id `video`), a scalar anchor whose `value` is seconds and `ratePerMs` is `0` (paused) or `1/1000` (playing). Everything else lives in `meta`:

- `videoId` — the currently loaded YouTube id (or null).
- `intentPlaying` — does the room *want* to be playing? Distinct from any one viewer's effective state (a viewer can be buffering an ad while the room intends to play).
- `viewers` — live viewer count.

Keeping intent separate from the anchor matters: `intentPlaying` is a boolean, but the **effective `video` anchor is the only position truth**. Play writes a playing anchor from the current position; pause writes a paused anchor at the current position; seek writes an anchor at the new position. No client ever invents a position that isn't on the shared timeline.

## Client sync loop

Each client runs **one ordered tick** (`TICK_MS` ~100ms, plus an immediate call on every `onStateChange`). Running capture and correction in a single ordered pass — rather than two independent loops — is what prevents the follower from "correcting" a fresh native action back to the stale anchor before it has been broadcast. The tick, in order:

1. **Load** a newly-selected video (cue if the room is paused, load if playing) and open a settle window.
2. **Sample + classify** the native input (`lib/sync-engine.ts#classifyCapture`).
3. **Capture**: if the viewer did something, apply an optimistic local anchor, broadcast the control, and **return** — so correction never runs against an un-broadcast action.
4. **Follow** the room anchor otherwise: drift correction, then play/pause state.

### Capture — classifying native input

The IFrame API has no seek event, so we poll `getCurrentTime()` and classify (`classifyCapture`):

- A playhead jump beyond what playback could account for (`> SEEK_JUMP_S`, 2s) is a **seek** — it carries its own time and suppresses the play/pause flicker a scrub produces.
- **A transition into `playing`** (from any non-playing phase) is a **play** — including the `paused → buffering → playing` a stale video produces, because buffering is frozen so the prior phase still reads as `paused`. We deliberately do **not** treat `paused → buffering` *itself* as a play: a follower correcting to a paused frame seeks, which momentarily buffers, and reading that as a play would broadcast a phantom play and un-pause the whole room. The "press play doesn't start" bug is prevented instead by the follower only ever force-pausing an *actually-playing* player (never a buffering one — see below), so a real play press survives buffering and is captured the moment it reaches `playing`.
- A start from a cued/ended state into `playing` is a **play**.
- `playing → paused` is a **pause**.

Buffering is treated as **transient**: the caller freezes the last *non-buffering* phase, so a mid-playback rebuffer (`playing → buffering → playing`) reads as "still playing" (nothing), while a real play (`paused → buffering → playing`) reads as "left paused" (a play). That single rule is what disambiguates a user's play press from a network hiccup.

### Optimistic anchor

On capture we apply an **optimistic local anchor** immediately, so the acting viewer's player isn't dragged by the stale SSE snapshot during the POST round-trip. The optimistic anchor overrides the snapshot until the snapshot confirms it (`anchorAgrees` within `AGREE_TOL_S`) or an `OPTIMISTIC_MS` safety timeout elapses.

### Echo suppression — per-type settle windows

Our own programmatic commands (`playVideo` / `pauseVideo` / `seekTo` / load) fire the same events a user would. We suppress that echo with **short settle windows scoped per action type** — a separate one for seeks (`SEEK_SETTLE_MS`) and for play/pause (`STATE_SETTLE_MS`); a load settles both (`LOAD_SETTLE_MS`). Scoping matters: a settling correction *seek* must not also swallow a genuine *pause* the viewer makes in the same instant, so each captured kind is suppressed only while its own window is open. The playhead sample still advances every tick so our command never reads back as a jump once the window lifts. The windows are deliberately short (hundreds of ms) so they can never swallow a *real* action the viewer makes immediately after — the bug an aggressive multi-second guard caused.

### Correction — adaptive tolerance + seek-latency compensation

When no native action is captured, the follower tracks the effective anchor and:

- corrects drift only when `|cur - target| > effectiveTolerance(tol, duration)`, rate-limited to once per `CORRECTION_COOLDOWN_MS` unless the anchor just changed;
- **grows** `tol` (`nextTolerance`, capped at `TOL_MAX_S`) on each correction and **resets** it on any anchor change — the anti-seek-storm mechanism, so a struggling follower can't thrash;
- pre-compensates the seek target (`compensatedTarget`) with a learned seek-latency offset, enabled once a seek lands within `CALIBRATE_S`, so corrections land on the live frame;
- **only force-pauses an actually-playing player**, never a merely-buffering one (re-pausing a buffering viewer is what made a play press fail to stick).

Every seek — correction or otherwise — is routed through a `canSeek(phase)` guard that **drops the seek while buffering** (`safeSeek`). Seeking into a buffering player is ignored by YouTube anyway and only compounds a stall, so this is a hard invariant rather than a scattered check.

### Self-heal, no barrier

There is **no room-wide readiness barrier**. Correction is **skipped while the player reports `BUFFERING`/`UNSTARTED`** (and the `safeSeek` invariant blocks any stray seek there too), so a stalled viewer (an ad, a slow load) is simply left alone and snaps to the live position when its content clock resumes. One person's ad never freezes the room. This is a deliberate product choice: simplicity and the elimination of false-positive "waiting for others," at the cost of perfect togetherness for a stalled viewer.

### Scheduled start

On `load` the anchor is placed `SCHEDULED_START_LEAD_MS` (~1.8s) in the future so every viewer can buffer before playback advances. Until that start arrives the follower actively **holds the player paused at 0** and releases it `SCHEDULED_PLAY_LEAD_MS` (~200ms) early (`scheduledStartDelayMs`) to pre-empt the player's own play latency. A future-dated video is *cued* (not loaded) so it can't autoplay early. Without the hold the player would play as soon as it saw the playing anchor, run ahead of the clamped-to-0 target, and get yanked back — a start-of-video stutter; the hold makes every viewer begin on the same frame.

## Autoplay reality

Browsers block programmatic unmuted playback without a user gesture, so the room requires a one-time **click-to-join** gesture; from then on, remote-driven play/seek/load are applied programmatically. If a programmatic unmuted `playVideo()` is rejected, we fall back to muted playback and surface an "unmute" affordance.

## Embedding approach

We use the standard YouTube IFrame Player API (`https://www.youtube.com/iframe_api`) with native controls (`controls: 1`). Alternatives (raw `<iframe>` with `enablejsapi`, the privacy `youtube-nocookie.com` host) have the same fundamental constraints — ads, login/Premium state, and embed permissions are all controlled by YouTube, not us. There is no embedding mode immune to ads or third-party-cookie policies while still giving us JS playback control. We accept this and design the self-heal around it.

## Redis layout (all under the `wp:` prefix)

`REDIS_URL` is shared with other apps (e.g. syncframe, which uses the `syncframe:` prefix), so every key is namespaced under `wp:`:

- `wp:<room>:anchor:video`, `wp:<room>:meta`, `wp:<room>:channels`, `wp:<room>:content` — managed by `RedisStore({ prefix: 'wp' })`.
- `wp:<room>:updates` — pub/sub channel, managed by `RedisTransport({ prefix: 'wp' })`.
- `wp:<room>:exists` — room existence marker.
- `wp:<room>:clients` — hash of `clientId -> { lastSeen }` for the presence/viewer count.

Sliding TTL: every control and heartbeat re-`EXPIRE`s all of a room's keys to 1 week.

## Server clock accuracy

`@syncframe/core`'s `useServerClock` derives each probe's RTT and local midpoint from the **Resource Timing API** (`responseEnd - requestStart`, the pure network span) when available, falling back to a `Date.now()` bracket otherwise. This removes main-thread/JS scheduling jitter from the offset estimate; the offset+skew linear fit on top is unchanged. This was generalized into the library (shipped as `@syncframe/core@0.2.2`) rather than kept app-local, since accurate one-way latency benefits every consumer.

## Out of scope for v1

- **Playback-rate sync** — the anchor model already supports arbitrary `ratePerMs`, so speed control is a small follow-up, but v1 fixes 1x.
- **WebSocket transport** — controls are POST to `/api/room/control` and updates fan out over SSE (`/api/room/stream`). The optimistic anchor hides the round-trip for the acting viewer; a bidirectional WebSocket over the existing Redis pub/sub is the lowest-latency endpoint and is tracked in `TECH_DEBT.md`.
- Per-user identities / names, chat, room passwords, and a Playwright end-to-end test of the player.
