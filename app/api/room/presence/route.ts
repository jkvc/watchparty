import { NextRequest } from 'next/server';
import { isValidRoomId, normalizeRoomId } from '@/lib/room';
import { heartbeatAndPublish, leaveAndPublish } from '@/lib/room-server';

export const dynamic = 'force-dynamic';

// POST { roomId, clientId, leaving? } — presence heartbeat for the viewer count.
// `leaving: true` (typically via sendBeacon on unload) drops the client.
export async function POST(request: NextRequest) {
  try {
    const { roomId, clientId, leaving } = (await request.json()) as {
      roomId?: unknown;
      clientId?: unknown;
      leaving?: unknown;
    };
    if (typeof roomId !== 'string' || !isValidRoomId(roomId)) {
      return Response.json({ error: 'Invalid room id' }, { status: 400 });
    }
    if (typeof clientId !== 'string' || !clientId) {
      return Response.json({ error: 'Invalid client id' }, { status: 400 });
    }
    const id = normalizeRoomId(roomId);

    if (leaving === true) {
      await leaveAndPublish(id, clientId);
    } else {
      await heartbeatAndPublish(id, clientId);
    }
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
