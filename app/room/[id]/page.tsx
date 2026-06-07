import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { isValidRoomId, normalizeRoomId } from '@/lib/room';
import { roomExists } from '@/lib/room-server';
import { RoomClient } from './room-client';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
    params,
}: {
    params: Promise<{ id: string }>;
}): Promise<Metadata> {
    const { id } = await params;
    const roomId = normalizeRoomId(id);
    return { title: `watch·party - ${roomId}` };
}

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!isValidRoomId(id)) redirect(`/?notfound=${encodeURIComponent(id)}`);

    const roomId = normalizeRoomId(id);
    // Unknown / expired rooms bounce back to the entrance with a "not found" note.
    if (!(await roomExists(roomId))) redirect(`/?notfound=${roomId}`);

    return <RoomClient roomId={roomId} />;
}
