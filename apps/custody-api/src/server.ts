import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { createPasskeyVerifier } from './auth/passkeys.js';
import { parseServerEnvironment, type ServerEnvironment } from './config.js';
import { createDfnsClient } from './custody/client.js';
import { createDfnsCustody } from './custody/dfns.js';
import { createPrismaClient } from './db.js';
import { consoleLogger } from './deps.js';
import { createFriendbotFunder, noFunding } from './funding/friendbot.js';
import { loadPolicy } from './policy/policy.js';
import { PrismaStore } from './store/prisma.js';

/// Builds the server with the real ports: PostgreSQL, Dfns (initiator
/// service account), SimpleWebAuthn and Friendbot on testnet.
export async function buildServer(environment: ServerEnvironment): Promise<FastifyInstance> {
  const prisma = createPrismaClient(environment.DATABASE_URL);
  const client = createDfnsClient({
    apiUrl: environment.DFNS_API_URL,
    orgId: environment.DFNS_ORG_ID,
    authToken: environment.DFNS_AUTH_TOKEN,
    credId: environment.DFNS_CRED_ID,
    privateKey: environment.DFNS_PRIVATE_KEY,
  });
  const app = await buildApp({
    store: new PrismaStore(prisma),
    custody: createDfnsCustody(client, environment.STELLAR_NETWORK),
    passkeys: createPasskeyVerifier({
      id: environment.WEBAUTHN_RP_ID,
      name: environment.WEBAUTHN_RP_NAME,
      origin: environment.WEBAUTHN_ORIGIN,
    }),
    funder:
      environment.STELLAR_NETWORK === 'testnet'
        ? createFriendbotFunder(environment.FRIENDBOT_URL)
        : noFunding,
    policy: loadPolicy(environment.STELLAR_NETWORK),
    network: environment.STELLAR_NETWORK,
    corsOrigin: environment.CORS_ORIGIN,
    sessionTtlHours: environment.SESSION_TTL_HOURS,
    now: () => new Date(),
    log: consoleLogger,
  });
  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
  return app;
}

const isMainModule =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const environment = parseServerEnvironment(process.env);
  const app = await buildServer(environment);
  await app.listen({ port: environment.PORT, host: environment.HOST });
  console.log(
    `custody-api: http://${environment.HOST}:${environment.PORT} (${environment.STELLAR_NETWORK}), front ${environment.CORS_ORIGIN}`,
  );
}
