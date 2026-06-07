# Tech Debt

Known shortcuts and deferred work. Record every conscious shortcut here; delete entries once resolved.

## Active

### Control transport is POST + SSE, not a WebSocket
Native controls broadcast via a `fetch` POST to `/api/room/control`, and updates fan out over an SSE stream (`/api/room/stream`). That's a fresh request per control plus server-side recompute and SSE buffering — higher latency than a persistent socket. An optimistic local anchor hides the round-trip for the acting viewer, but cross-viewer propagation still pays it. A bidirectional WebSocket (`ws`/`socket.io`) over the existing Redis pub/sub would be lowest-latency for both directions. Deferred for v1; the optimistic anchor makes it good enough.

### Native-input capture is heuristic
The IFrame API has no seek event, so a single loop (`TICK_MS` ~100ms) polls `getCurrentTime()` and classifies a playhead jump > `SEEK_JUMP_S` (2s) as a user seek, otherwise reads play/pause from the state transition (`lib/sync-engine.ts#classifyCapture`). Capture runs *before* drift correction in the same tick and returns on a captured action, so the follower never "corrects" a fresh native action back to the stale anchor. Our own programmatic commands open short, *per-type* settle windows (`SEEK_SETTLE_MS` / `STATE_SETTLE_MS` / `LOAD_SETTLE_MS`) — scoped so a settling seek can't swallow a genuine play/pause, and deliberately short so they never swallow a real action the viewer makes right after. Optimistic-anchor confirmation is position-based (`anchorAgrees` within `AGREE_TOL_S`) with an `OPTIMISTIC_MS` safety timeout. Edge cases: two viewers acting within the same tick resolve last-write-wins; an ad whose content clock is frozen reads as drift and is corrected (harmless catch-up seek); a sub-2s scrub is treated as drift and pulled back. Acceptable for a casual watch party.

### Ad time is opaque (self-heal, not detected)
The IFrame API does not expose whether an ad is playing. We no longer try to detect ads or gate the room; instead a stalled/ad viewer falls behind and the drift-correction loop snaps them to live when their content clock resumes. Ad-specific handling is skipping corrections while the player reports `BUFFERING`/`UNSTARTED`, plus a hard `canSeek`/`safeSeek` invariant that drops *any* seek while buffering. A viewer stuck on a long ad simply stays behind until the ad ends and then self-heals, rather than seek-storming.

### No playback-rate sync (fixed 1x)
v1 intentionally syncs only play / pause / seek / load. The anchor model already supports arbitrary `ratePerMs`, so adding speed control is a small follow-up, but it's out of scope for now.

### Presence is heartbeat-polled, not event-driven
Viewer count is derived from periodic heartbeats in a Redis sorted set with a staleness window, not from connection lifecycle events. A viewer who closes their tab without firing the unload beacon lingers in the count until their heartbeat goes stale. Acceptable for a casual watch party.

### No automated end-to-end test of the YouTube player
The pure domain logic (`lib/room.ts`) is unit-tested and the API routes are probed against a live Redis, but the actual IFrame player + reconcile loop is only verified manually in a browser. A Playwright-driven smoke test would close the gap.

### No CI pipeline
There is a local pre-push hook (type-check, lint, test, isolated build) but no GitHub Actions workflow yet.
