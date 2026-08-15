import type { FastifyInstance } from 'fastify';
import { loadPool, poolAggregates, VIN_PATTERN } from './pool.js';

export async function assetPoolRoutes(app: FastifyInstance): Promise<void> {
  // Full pool + aggregates (the diagram's AUTOMOBILE ASSET POOL box).
  app.get('/asset-pool', async () => {
    const pool = loadPool();
    return {
      poolId: pool.poolId,
      dealName: pool.dealName,
      cutOffDate: pool.cutOffDate,
      currencyLabel: pool.currencyLabel,
      note: pool.note,
      aggregates: poolAggregates(pool),
      vehicles: pool.vehicles,
    };
  });

  // One exposure per VIN (Loan-Lease Contract / Obligor / Vehicle / Battery).
  app.get('/asset-pool/:vin', async (request, reply) => {
    const { vin } = request.params as { vin: string };
    if (!VIN_PATTERN.test(vin)) {
      return reply.status(400).send({ error: 'Invalid VIN (17 characters, no I/O/Q)' });
    }
    const entry = loadPool().vehicles.find((vehicle) => vehicle.vin === vin);
    if (!entry) return reply.status(404).send({ error: 'VIN not in the pool' });
    return entry;
  });
}
