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

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      // Push the current snapshot immediately so a fresh client syncs at once.
      send(await server.buildSnapshot(roomId));

      unsubscribe = await server.subscribe(roomId, (snapshot) => send(snapshot));

      // Comment heartbeat keeps intermediaries from closing an idle stream.
      heartbeat = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 30_000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
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
