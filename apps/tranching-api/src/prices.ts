import { prisma } from './db.js';
import { environment } from './config.js';
import { reflectorPrices } from './stellar.js';

const HOUR = 3600;

/// Upsert `{ ts, price }` points into price_snapshot, deduped by the hour.
export async function upsertPoints(
  symbol: string,
  points: { ts: number; price: number }[],
): Promise<number> {
  for (const point of points) {
    const bucket = Math.floor(point.ts / HOUR);
    await prisma.priceSnapshot.upsert({
      where: { symbol_bucket: { symbol, bucket } },
      create: { symbol, bucket, ts: new Date(point.ts * 1000), priceUsd: point.price },
      update: { ts: new Date(point.ts * 1000), priceUsd: point.price },
    });
  }
  return points.length;
}

/// Accumulate the recent Reflector price window (a real on-chain oracle).
export async function recordReflectorPrices(
  symbol: string,
  log?: { info: (message: string) => void },
): Promise<void> {
  if (!environment.REFLECTOR_CONTRACT_ID) return;
  const points = await reflectorPrices(environment.REFLECTOR_CONTRACT_ID, symbol, 20);
  if (points.length) {
    await upsertPoints(symbol, points);
    log?.info(`[prices] +${points.length} points ${symbol} depuis Reflector`);
  }
}

/// Stored history (oldest to newest) over `days` days.
export async function getPriceHistory(
  symbol: string,
  days: number,
): Promise<{ ts: number; price: number }[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.priceSnapshot.findMany({
    where: { symbol, ts: { gte: since } },
    orderBy: { ts: 'asc' },
  });
  return rows.map((row) => ({ ts: Math.floor(row.ts.getTime() / 1000), price: row.priceUsd }));
}
