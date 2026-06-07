import { Entrance } from './entrance';

export const dynamic = 'force-dynamic';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ notfound?: string }>;
}) {
  const { notfound } = await searchParams;
  return <Entrance notFoundId={notfound ?? null} />;
}
