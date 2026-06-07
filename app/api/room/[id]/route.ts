import { NextRequest } from 'next/server';
import { isValidRoomId, normalizeRoomId } from '@/lib/room';
import { roomExists } from '@/lib/room-server';

export const dynamic = 'force-dynamic';

// GET — does this room exist? Used by the entrance to validate a join code.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!isValidRoomId(id)) {
      return Response.json({ exists: false }, { status: 400 });
    }
    const exists = await roomExists(normalizeRoomId(id));
    return Response.json({ exists }, { status: exists ? 200 : 404 });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
