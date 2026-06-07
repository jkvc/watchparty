import { createRoom } from '@/lib/room-server';

export const dynamic = 'force-dynamic';

// POST — create a new room with a unique code.
export async function POST() {
  try {
    const roomId = await createRoom();
    if (!roomId) {
      return Response.json({ error: 'Could not allocate a room code, try again' }, { status: 503 });
    }
    return Response.json({ roomId });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
