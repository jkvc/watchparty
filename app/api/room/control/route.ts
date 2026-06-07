import { NextRequest } from 'next/server';
import { isControlAction, isValidRoomId, normalizeRoomId } from '@/lib/room';
import { applyControlAndPublish, roomExists } from '@/lib/room-server';

export const dynamic = 'force-dynamic';

// POST { roomId, action, atServerMs? } — apply a play/pause/seek/load control.
// `atServerMs` is the acting client's synced server-clock time, used to stamp the
// anchor so it matches the client's optimistic one (server clamps it).
export async function POST(request: NextRequest) {
  try {
    const { roomId, action, atServerMs } = (await request.json()) as {
      roomId?: unknown;
      action?: unknown;
      atServerMs?: unknown;
    };
    if (typeof roomId !== 'string' || !isValidRoomId(roomId)) {
      return Response.json({ error: 'Invalid room id' }, { status: 400 });
    }
    if (!isControlAction(action)) {
      return Response.json({ error: 'Invalid action' }, { status: 400 });
    }
    const id = normalizeRoomId(roomId);
    if (!(await roomExists(id))) {
      return Response.json({ error: 'Room not found' }, { status: 404 });
    }
    await applyControlAndPublish(id, action, typeof atServerMs === 'number' ? atServerMs : undefined);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
