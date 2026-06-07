'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { isValidRoomId, normalizeRoomId, ROOM_ID_LENGTH } from '@/lib/room';
import { Footer } from '@/app/components/Footer';

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
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="font-display text-7xl leading-none tracking-wide">
            watch<span className="mx-1 text-muted">·</span><span className="text-primary">party</span>
          </h1>
          <p className="mt-3 font-mono text-sm uppercase tracking-[0.25em] text-muted">
            <span className="text-primary">&gt;</span> youtube, perfectly in sync
          </p>
        </div>

        <div className="border-2 border-border bg-surface/80 p-6 shadow-[0_0_30px_rgba(255,184,70,0.08)]">
          {error && (
            <div className="mb-5 border-2 border-accent/40 bg-accent/10 px-4 py-3 font-mono text-sm text-accent">
              ! {error}
            </div>
          )}

          <button
            onClick={createRoom}
            disabled={busy}
            className="w-full border-2 border-primary bg-primary px-4 py-3.5 font-mono text-base font-bold uppercase tracking-wider text-background transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? 'Booting…' : 'New room'}
          </button>

          <div className="my-6 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
            <div className="h-px flex-1 bg-border" />
            or join
            <div className="h-px flex-1 bg-border" />
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
              className="min-w-0 flex-1 border-2 border-border bg-surface-2 px-4 py-3 text-center font-mono text-xl tracking-[0.4em] uppercase text-primary outline-none placeholder:text-faint focus:border-primary"
            />
            <button
              type="submit"
              disabled={busy}
              className="border-2 border-border-strong px-5 py-3 font-mono text-base font-bold uppercase tracking-wider transition-colors hover:border-primary disabled:opacity-50"
            >
              Join
            </button>
          </form>
        </div>

        <Footer className="mt-8 flex-wrap" />
      </div>
    </main>
  );
}
