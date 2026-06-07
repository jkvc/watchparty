# watchparty — end-of-video handling (2026-06-07)

How the room handles a video reaching its natural end, and how a late joiner tunes into a room whose video has already finished. This supplements the sync-design note; the tick ordering and anchor model there are unchanged.

## The problem

The YouTube IFrame API fights every attempt to gracefully "park" on a finished video:

- `pauseVideo()` is a **no-op in the `ENDED` state** — you cannot pause an ended player onto its last frame.
- `seekTo()` from `ENDED` is **unreliable** — it often does nothing or silently restarts.
- `loadVideoById(id, nearEndPosition)` makes the player **buffer the very end forever** (a blank stage, with `getDuration()` stuck at `0`), and on mobile it produces a **first-second replay loop**: the player treats a load at/just-before the end as "play from a point that immediately ends," loops the opening, and won't advance.
- At `ENDED`, some clients (notably mobile) report `getCurrentTime() === 0`. Classified naively, that reads as a **seek-to-start**, which we'd broadcast — yanking the whole room back to 0 in a loop.

These combined into a string of symptoms: a finished video shown as a black box; refresh + "Tune in" landing on a permanent blank; and a sub-second replay loop on mobile.

## The approach: explicit ended state, never autoplay into the end

We stopped trying to render YouTube's last frame. Instead the end of a video is an **explicit room state** with its own UI, and we **never autoplay *into* the clip end**.

### 1. Detecting the end

The follower tick marks the room ended in two ways (`endedRef` + `videoEnded` React state):

- **Natural end**: `state === YT_STATE.ENDED`. We mark ended, leave the playhead sample frozen as `paused`, and — if the room still intends to play — broadcast a single `pause` stamped at the hold position so the shared anchor stops advancing. Handling this *before* capture is what kills the `curPos === 0` → phantom-seek loop.
- **Late join to a finished room**: there is no `ENDED` event to catch, because we cue rather than load (below). The tick instead checks the anchor: a paused anchor within `END_NEAR_S` (2s) of the duration (`isNearEnd`, `lib/sync-engine.ts`) counts as finished. The 2s margin matters — the exact stored end position varies by a fraction of a second each time (the 100ms capture tick fires slightly before/after the real end, and YouTube rounds), so a tight threshold missed real cases (e.g. a clip parked at `89.84` on a 90s video).

### 2. Cue, don't load, for paused / late joins

The load branch now only **loads (autoplays)** for an actively-playing anchor whose start is already in the past. **Every paused join and every future-dated start is cued** (`cueVideoById`):

- Cueing **loads metadata** so `getDuration()` returns the real duration immediately → near-end detection can run.
- Cueing **shows the poster**, never a black buffering-the-end stage.
- Cueing **never autoplays into the end**, which is the root cause of both the blank and the mobile first-second loop.

Tradeoff: tuning into a room paused *mid-video* shows the poster thumbnail rather than the exact paused frame until playback resumes. Recorded in `TECH_DEBT.md`.

### 3. The ended overlay + Replay

When `videoEnded` is set, an opaque "Signal ended" overlay covers the stage (so whatever the player shows underneath — poster, black, ended screen — is irrelevant) with a **Replay** button.

**Replay** drives the restart *directly in the click handler* — not via the tick — for two reasons:

- It counts as a **user gesture**, so unmuted autoplay is allowed (deferring to the tick got the play blocked and fell back to muted, surfacing an unwanted unmute button).
- It loads at `0` immediately, so it can't re-use the stale past-end anchor and re-trigger the ended overlay (the "click Replay → blank → button reappears → click again" double-replay bug).

Replay also broadcasts a `load` control, so a finished video restarts **in sync for the whole room** (scheduled start from 0). A viewer who is parked at `ENDED` when a *remote* peer replays detects the room's playing-from-start anchor and force-reloads to rejoin.

## Server-side: `pause` carries a position

`applyControl`'s `pause` action accepts an optional `positionSec`. At the natural end we pause with the explicit hold position (`endHoldPosition(duration)`) rather than letting the still-advancing playing anchor decide, so the stored anchor lands at a stable end frame instead of drifting past the duration.

## SSE stream robustness (related fix)

The end-of-video churn surfaced an unrelated crash: the `/api/room/stream` `ReadableStream` could `enqueue` after the client disconnected, throwing `ERR_INVALID_STATE` as an uncaught exception. The route now tracks a `closed` flag, listens on `request.signal` abort, guards every `enqueue` in a `try/catch` that runs cleanup, and shares teardown between `cancel()` and the abort handler.

## Pure, tested helpers (`lib/sync-engine.ts`)

- `isNearEnd(position, duration, margin = END_NEAR_S)` — is a position close enough to the end to count as finished.
- `endHoldPosition(duration)` — the last holdable frame (`duration - END_HOLD_OFFSET_S`).
- `resolveEndPosition`, `clampTargetToDuration` — clamp/resolve helpers used when reasoning about end positions.

All are unit-tested; the component supplies player observations and applies the decisions.
