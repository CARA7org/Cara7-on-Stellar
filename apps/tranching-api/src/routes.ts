import type { FastifyInstance } from 'fastify';
import { prisma } from './db.js';
import { trancheStats, trancheHistory, userPositions, userPositionHistory } from './metrics.js';
import { getPriceHistory } from './prices.js';

/// Indexer routes on the notes side. The /vaults/* family died with the vault
/// generation: a note has neither NAV nor share price.
export async function indexerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true }));

  // Investor state of a note (factor, outstanding, coupon, totals).
  app.get('/notes/:id/stats', async (request, reply) => {
    const { id } = request.params as { id: string };
    const stats = await trancheStats(id);
    if (!stats) return reply.code(404).send({ error: 'unknown note contract' });
    return stats;
  });

  // Time series of the snapshots. ?range=7d|30d|60d|90d|all
  app.get('/notes/:id/history', async (request) => {
    const { id } = request.params as { id: string };
    const { range } = request.query as { range?: string };
    return trancheHistory(id, range ?? '30d');
  });

  // Holder registry of a note (positions + counters).
  app.get('/notes/:id/holders', async (request) => {
    const { id } = request.params as { id: string };
    const rows = await prisma.userPosition.findMany({
      where: { tranche: id, units: { gt: 0 } },
      orderBy: { units: 'desc' },
    });
    const supply = rows.reduce((sum, row) => sum + BigInt(row.units.toString()), 0n);
    return rows.map((row) => ({
      address: row.address,
      units: row.units.toString(),
      sharePct: supply > 0n ? Number((BigInt(row.units.toString()) * 10_000n) / supply) / 100 : 0,
      interestReceived: row.interestReceived.toString(),
      principalReceived: row.principalReceived.toString(),
    }));
  });

  // Positions of an address, across every note.
  app.get('/users/:address/positions', async (request) => {
    const { address } = request.params as { address: string };
    return userPositions(address);
  });

  // Position value over time (remaining claim + total received).
  app.get('/users/:address/notes/:id/history', async (request) => {
    const { address, id } = request.params as { address: string; id: string };
    const { range } = request.query as { range?: string };
    return userPositionHistory(id, address, range ?? '30d');
  });

  // Latest on-chain events of a contract (audit trail). ?limit=10
  app.get('/notes/:id/events', async (request) => {
    const { id } = request.params as { id: string };
    const { limit } = request.query as { limit?: string };
    const bounded = Math.min(Math.max(Number(limit ?? '10'), 1), 50);
    const rows = await prisma.stellarEvent.findMany({
      where: { contractId: id },
      orderBy: { id: 'desc' },
      take: bounded,
      select: { id: true, type: true, ts: true, ledger: true, topic: true, data: true },
    });
    return rows;
  });

  // Stored USD history for a ticker. ?days=7|30|90|...
  app.get('/prices/:symbol', async (request) => {
    const { symbol } = request.params as { symbol: string };
    const { days } = request.query as { days?: string };
    const boundedDays = Math.min(Math.max(Number(days ?? '30'), 1), 365);
    return getPriceHistory(symbol.toUpperCase(), boundedDays);
  });
}
