import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { environment } from './config.js';
import { mapDirectory } from './paths.js';
import { mapRoutes } from './map/routes.js';
import { assetPoolRoutes } from './asset-pool/routes.js';
import { ipfsRoutes } from './ipfs/gateway.js';
import { tokensRoutes } from './tokens/routes.js';
import { waterfallRoutes } from './waterfall/routes.js';
import { reportingRoutes } from './reporting/dashboard.js';
import { edwRoutes } from './reporting/edw-export.js';
import { operationRoutes } from './custody/routes.js';
import { defaultOperatorServices, type OperatorServices } from './custody/services.js';

/**
 * `services` holds the custody port and the network port. Production uses
 * Dfns and Soroban RPC. Tests give fakes, so they run offline.
 */
export async function buildServer(
  services: OperatorServices = defaultOperatorServices(),
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // The clickable Data Spec Book map is the home page.
  await app.register(fastifyStatic, { root: mapDirectory });
  await app.register(mapRoutes);
  await app.register(assetPoolRoutes);
  await app.register(ipfsRoutes);
  await app.register(tokensRoutes);
  await app.register(waterfallRoutes(services));
  await app.register(operationRoutes(services.operator));
  await app.register(reportingRoutes);
  await app.register(edwRoutes);
  return app;
}

const isMainModule =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const app = await buildServer();
  await app.listen({ port: environment.PORT, host: environment.HOST });
  console.log(`spv-backend : http://${environment.HOST}:${environment.PORT} (map on /)`);
}
