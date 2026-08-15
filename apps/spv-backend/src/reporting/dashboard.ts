import type { FastifyInstance } from 'fastify';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { environment } from '../config.js';
import { loadPool, poolAggregates } from '../asset-pool/pool.js';
import { loadRegistry } from '../tokens/registry.js';
import { reportsDirectory } from '../paths.js';
import { waterfallState } from '../waterfall/routes.js';

/// The diagram's Reporting Dashboard: consolidated deal state as one JSON,
/// plus the reports produced by the agents (reporting/reports/*.md).
export async function reportingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reporting', async () => {
    const pool = loadPool();
    const registry = loadRegistry();

    let tranches: unknown = null;
    let distributions: unknown = null;
    try {
      const trancheResponse = await fetch(`${environment.TRANCHING_API_URL}/api/tranches`);
      if (trancheResponse.ok) tranches = ((await trancheResponse.json()) as { tranches: unknown }).tranches;
      const dealsResponse = await fetch(`${environment.TRANCHING_API_URL}/api/deals/1/distributions`);
      if (dealsResponse.ok) distributions = await dealsResponse.json();
    } catch {
      // tranching-api offline: the dashboard degrades gracefully
    }

    const reports = existsSync(reportsDirectory)
      ? readdirSync(reportsDirectory).filter((name) => name.endsWith('.md'))
      : [];

    // Waterfall v3 on-chain state (note factors, reserve, shortfalls) - the
    // docx 3.10 Note Factor exposure lives here rather than in tranching-api.
    const waterfall = await waterfallState().catch(() => null);

    return {
      pool: { poolId: pool.poolId, dealName: pool.dealName, aggregates: poolAggregates(pool) },
      nfts: registry
        ? { contracts: registry.contracts, tokenCount: registry.tokens.length }
        : { minted: false },
      dealContract: environment.DEAL_CONTRACT_ID,
      payingAgentContract: environment.PAYING_AGENT_CONTRACT_ID,
      waterfall,
      tranches,
      distributions,
      agentReports: reports,
    };
  });

  app.get('/reporting/reports/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const filePath = path.join(reportsDirectory, path.basename(name));
    if (!existsSync(filePath)) return reply.status(404).send({ error: 'Report not found' });
    reply.type('text/markdown');
    return readFileSync(filePath, 'utf8');
  });
}
