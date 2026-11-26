import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import cron from 'node-cron';
import { environment } from './config.js';
import { prisma } from './db.js';
import { indexerRoutes } from './routes.js';
import { registryRoutes, seedRegistry } from './registry.js';
import { ingestOnce } from './ingest.js';
import { takeDealSnapshot } from './snapshot.js';
import { recordReflectorPrices } from './prices.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });
  await app.register(indexerRoutes);
  await app.register(registryRoutes);
  return app;
}

interface Logger {
  info: (message: string) => void;
  error: (messageOrError: unknown, message?: string) => void;
}

/// One poller cycle: ingest the three contracts of the deal (abs-deal, paying
/// agent, note tokens) plus one snapshot per tranche, then accumulate the
/// Reflector prices. Overlapping cycles are skipped.
export function createTick(log: Logger): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const deals = await prisma.deal.findMany({
        include: { tranches: { orderBy: { classIndex: 'asc' } } },
      });
      for (const deal of deals) {
        const contracts = [
          deal.dealContractId,
          deal.payingAgentContractId,
          ...deal.tranches.map((tranche) => tranche.contractId),
        ].filter((id): id is string => Boolean(id));
        for (const contractId of contracts) {
          try {
            await ingestOnce(contractId, log);
          } catch (error) {
            log.error(error, `[poller] ingest ${contractId.slice(0, 8)} en echec`);
          }
        }
        if (deal.dealContractId) {
          try {
            await takeDealSnapshot(
              {
                dealContractId: deal.dealContractId,
                tranches: deal.tranches.map(({ classIndex, contractId }) => ({
                  classIndex,
                  contractId,
                })),
              },
              log,
            );
          } catch (error) {
            log.error(error, `[poller] snapshot ${deal.dealContractId.slice(0, 8)} en echec`);
          }
        }
      }
      await recordReflectorPrices('XLM', log);
    } catch (error) {
      log.error(error, '[poller] cycle en echec');
    } finally {
      running = false;
    }
  };
}

const isMainModule =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const app = await buildServer();
  await seedRegistry();

  const logger: Logger = {
    info: (message) => console.log(message),
    error: (messageOrError, message) => console.error(message ?? '', messageOrError),
  };
  const tick = createTick(logger);
  const seconds = Math.max(5, environment.CRON_INTERVAL_SECONDS);
  const expression = seconds % 60 === 0 ? `*/${seconds / 60} * * * *` : `*/${seconds} * * * * *`;
  cron.schedule(expression, tick);

  await app.listen({ port: environment.PORT, host: environment.HOST });
  console.log(`tranching-api: http://${environment.HOST}:${environment.PORT}, polling every ${seconds}s`);
  void tick(); // first cycle right away, so the data is fresh at boot
}
