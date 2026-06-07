# Tech Debt

Known shortcuts and deferred work. Record every conscious shortcut here; delete entries once resolved.

## Active

### End-of-video is an explicit overlay, and paused joins show the poster
We do not try to render YouTube's last frame at the natural end of a clip — `pauseVideo()` is a no-op in the `ENDED` state, `seekTo()` is unreliable there, and reloading near the end re-triggers `ENDED` (which produced black stages and a first-second replay loop, especially on mobile). Instead the follower detects the end (`state === ENDED`, or a paused anchor within `END_NEAR_S` of the duration via `isNearEnd`) and shows an opaque "Signal ended" overlay with a Replay button; Replay drives a `load`-from-0 directly in the click handler (user gesture → unmuted autoplay) and broadcasts `load` so the whole room restarts in sync. Relatedly, late joins to a *paused* room `cueVideoById` rather than `loadVideoById`: cueing loads metadata (so `getDuration()` works for near-end detection) and shows the poster instead of autoplaying *into* the clip end. Consequence: tuning into a room paused mid-video shows the poster thumbnail, not the exact paused frame, until playback resumes. Acceptable for v1; rendering the exact frame would require a brief programmatic play→pause that risks the autoplay-mute fallback.

### Control transport is POST + SSE, not a WebSocket
Native controls broadcast via a `fetch` POST to `/api/room/control`, and updates fan out over an SSE stream (`/api/room/stream`). That's a fresh request per control plus server-side recompute and SSE buffering — higher latency than a persistent socket. An optimistic local anchor hides the round-trip for the acting viewer, but cross-viewer propagation still pays it. A bidirectional WebSocket (`ws`/`socket.io`) over the existing Redis pub/sub would be lowest-latency for both directions. Deferred for v1; the optimistic anchor makes it good enough.

### Native-input capture is heuristic
The IFrame API has no seek event, so a single loop (`TICK_MS` ~100ms) polls `getCurrentTime()` and classifies a playhead jump > `SEEK_JUMP_S` (2s) as a user seek, otherwise reads play/pause from the state transition (`lib/sync-engine.ts#classifyCapture`). Capture runs *before* drift correction in the same tick and returns on a captured action, so the follower never "corrects" a fresh native action back to the stale anchor. Our own programmatic commands open short, *per-type* settle windows (`SEEK_SETTLE_MS` / `STATE_SETTLE_MS` / `LOAD_SETTLE_MS`) — scoped so a settling seek can't swallow a genuine play/pause, and deliberately short so they never swallow a real action the viewer makes right after. Optimistic-anchor confirmation is position-based (`anchorAgrees` within `AGREE_TOL_S`) with an `OPTIMISTIC_MS` safety timeout. Edge cases: two viewers acting within the same tick resolve last-write-wins; an ad whose content clock is frozen reads as drift and is corrected (harmless catch-up seek); a sub-2s scrub is treated as drift and pulled back. Acceptable for a casual watch party.

### Ad time is opaque (self-heal, not detected)
The IFrame API does not expose whether an ad is playing. We no longer try to detect ads or gate the room; instead a stalled/ad viewer falls behind and the drift-correction loop snaps them to live when their content clock resumes. Ad-specific handling is skipping corrections while the player reports `BUFFERING`/`UNSTARTED`, plus a hard `canSeek`/`safeSeek` invariant that drops *any* seek while buffering. A viewer stuck on a long ad simply stays behind until the ad ends and then self-heals, rather than seek-storming.

### Sync floor is the tolerance band, not exact (~100ms on late join)
The anchor is the shared truth, but the playing-drift loop only re-seeks once drift exceeds `TOL_BASE_S` (0.4s, growing), so every player free-runs *inside* that band rather than sitting exactly on the anchor. A fresh joiner snaps exactly onto the anchor while an established player is mid-band, so they can read ~100ms apart — below tolerance, so the loop never closes it (keyframe snapping on the first load adds to this). Imperceptible for watching together, so accepted for v1. Closing it means either tightening `TOL_BASE_S` (risks seek-storms on jittery networks — the reason the growing tolerance exists) or speed-nudge smoothing via `@syncframe/core`'s `useSmoothedValue` (glide into sync by briefly running off-1x instead of seeking), which pairs naturally with the deferred playback-rate sync below.

### No playback-rate sync (fixed 1x)
v1 intentionally syncs only play / pause / seek / load. The anchor model already supports arbitrary `ratePerMs`, so adding speed control is a small follow-up, but it's out of scope for now.

### Presence is heartbeat-polled, not event-driven
Viewer count is derived from periodic heartbeats in a Redis sorted set with a staleness window, not from connection lifecycle events. A viewer who closes their tab without firing the unload beacon lingers in the count until their heartbeat goes stale. Acceptable for a casual watch party.

### No automated end-to-end test of the YouTube player
The pure domain logic (`lib/room.ts`) is unit-tested and the API routes are probed against a live Redis, but the actual IFrame player + reconcile loop is only verified manually in a browser. A Playwright-driven smoke test would close the gap.

### No CI pipeline
There is a local pre-push hook (type-check, lint, test, isolated build) but no GitHub Actions workflow yet.
