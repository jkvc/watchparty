'use client';

import { useEffect, useState } from 'react';
import type { CoreSnapshot } from '@syncframe/core/react';
import { VIDEO_CHANNEL, type VideoAnchor } from '@/lib/room';

export interface RoomMeta {
  videoId: string | null;
  intentPlaying: boolean;
  viewers: number;
}

export interface RoomSnapshot {
  anchor: VideoAnchor | null;
  meta: RoomMeta;
  connected: boolean;
}

const EMPTY_META: RoomMeta = {
  videoId: null,
  intentPlaying: false,
  viewers: 0,
};

function parseMeta(meta: Record<string, unknown>): RoomMeta {
  return {
    videoId: typeof meta.videoId === 'string' ? meta.videoId : null,
    intentPlaying: meta.intentPlaying === true,
    viewers: typeof meta.viewers === 'number' ? meta.viewers : 0,
  };
}

/** Subscribe to a room's CoreSnapshot SSE stream and expose the parsed state. */
export function useRoomSnapshot(roomId: string): RoomSnapshot {
  const [snapshot, setSnapshot] = useState<RoomSnapshot>({
    anchor: null,
    meta: EMPTY_META,
    connected: false,
  });

  useEffect(() => {
    const source = new EventSource(`/api/room/stream?roomId=${encodeURIComponent(roomId)}`);

    source.onmessage = (event) => {
      try {
        const snap = JSON.parse(event.data) as CoreSnapshot;
        const anchor = (snap.anchors?.[VIDEO_CHANNEL] as VideoAnchor | null) ?? null;
        setSnapshot({ anchor, meta: parseMeta(snap.meta ?? {}), connected: true });
      } catch {
        // Ignore malformed frames; the next one will resync.
      }
    };

    source.onerror = () => {
      setSnapshot((prev) => ({ ...prev, connected: false }));
    };

    return () => source.close();
  }, [roomId]);

  return snapshot;
}
