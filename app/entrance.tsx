'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { isValidRoomId, normalizeRoomId, ROOM_ID_LENGTH } from '@/lib/room';

export function Entrance({ notFoundId }: { notFoundId: string | null }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    notFoundId ? `Room ${notFoundId} doesn't exist or has expired.` : null,
  );

  const createRoom = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/room', { method: 'POST' });
      const data = (await res.json()) as { roomId?: string; error?: string };
      if (!res.ok || !data.roomId) throw new Error(data.error ?? 'Failed to create room');
      router.push(`/room/${data.roomId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = normalizeRoomId(code);
    if (!isValidRoomId(id)) {
      setError(`A room code is ${ROOM_ID_LENGTH} letters or numbers.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/room/${id}`);
      if (res.status === 200) {
        router.push(`/room/${id}`);
        return;
      }
      setError(`Room ${id} doesn't exist or has expired.`);
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            watch<span className="text-rose-500">party</span>
          </h1>
          <p className="mt-2 text-sm text-neutral-400">Watch YouTube together, perfectly in sync.</p>
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            {error}
          </div>
        )}

        <button
          onClick={createRoom}
          disabled={busy}
          className="w-full rounded-xl bg-rose-500 px-4 py-3 font-medium text-white transition-colors hover:bg-rose-400 disabled:opacity-50"
        >
          Create a room
        </button>

        <div className="my-6 flex items-center gap-3 text-xs text-neutral-500">
          <div className="h-px flex-1 bg-neutral-800" />
          OR JOIN ONE
          <div className="h-px flex-1 bg-neutral-800" />
        </div>

        <form onSubmit={join} className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, ROOM_ID_LENGTH))}
            placeholder="CODE"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3 text-center font-mono text-lg tracking-[0.4em] uppercase outline-none focus:border-rose-500"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-xl border border-neutral-700 px-5 py-3 font-medium transition-colors hover:border-neutral-500 disabled:opacity-50"
          >
            Join
          </button>
        </form>

        <p className="mt-8 text-center text-xs text-neutral-600">
          Anyone with the room code can join and control playback.
        </p>
      </div>
    </main>
  );
}
