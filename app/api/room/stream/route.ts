import { NextRequest } from 'next/server';
import { isValidRoomId, normalizeRoomId } from '@/lib/room';
import { getSyncServer } from '@/lib/sync';
import { roomExists } from '@/lib/room-server';

export const dynamic = 'force-dynamic';

// Server-Sent Events: stream the room's CoreSnapshot to the connected client.
// The client reconcile loop consumes the `video` anchor + meta from each frame.
export async function GET(request: NextRequest) {
  const raw = new URL(request.url).searchParams.get('roomId') ?? '';
  if (!isValidRoomId(raw)) {
    return new Response('Invalid room id', { status: 400 });
  }
  const roomId = normalizeRoomId(raw);
  if (!(await roomExists(roomId))) {
    return new Response('Room not found', { status: 404 });
  }

  const server = getSyncServer();
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
        const unsub = unsubscribe;
        unsubscribe = undefined;
        unsub?.();
      };

      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };

      request.signal.addEventListener('abort', cleanup, { once: true });

      // Push the current snapshot immediately so a fresh client syncs at once.
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      send(await server.buildSnapshot(roomId));

      if (request.signal.aborted) {
        cleanup();
        return;
      }
      unsubscribe = await server.subscribe(roomId, (snapshot) => send(snapshot));

      // Comment heartbeat keeps intermediaries from closing an idle stream.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          cleanup();
        }
      }, 30_000);
    },
    cancel() {
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      const unsub = unsubscribe;
      unsubscribe = undefined;
      unsub?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
