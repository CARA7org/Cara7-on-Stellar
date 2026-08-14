import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { environment } from './env.js';
import { filesDirectory, publicDirectory } from './paths.js';
import { documentRoutes } from './routes/documents.js';
import { searchRoutes } from './routes/search.js';

export async function buildServer(): Promise<FastifyInstance> {
  mkdirSync(filesDirectory, { recursive: true });
  const app = Fastify({ logger: false });
  if (environment.CORS_ORIGIN) {
    await app.register(fastifyCors, { origin: environment.CORS_ORIGIN.split(',') });
  }
  const accessToken = environment.KB_TOKEN;
  if (accessToken) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS' || !request.url.startsWith('/api/')) return;
      const queryToken = new URL(request.url, 'http://placeholder').searchParams.get('token');
      const authorized =
        request.headers.authorization === `Bearer ${accessToken}` || queryToken === accessToken;
      if (!authorized) {
        return reply.status(401).send({ error: 'Access token required' });
      }
    });
  }
  await app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024, files: 20 } });
  await app.register(fastifyStatic, { root: publicDirectory });
  await app.register(documentRoutes);
  await app.register(searchRoutes);
  return app;
}

const isMainModule =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const app = await buildServer();
  await app.listen({ port: environment.PORT, host: environment.HOST });
  console.log(`docs-api: http://${environment.HOST}:${environment.PORT}`);
}
