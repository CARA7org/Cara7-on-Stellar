import fastifyCors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { authRoutes } from './auth/routes.js';
import type { AppDependencies } from './deps.js';
import { acceptEmptyJson, installErrorHandling } from './http.js';
import { signingRoutes } from './signing/routes.js';

/// Builds the HTTP app from its ports. It reads no environment variable.
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  installErrorHandling(app, deps.log);
  acceptEmptyJson(app);
  await app.register(fastifyCors, {
    origin: [deps.corsOrigin],
    methods: ['GET', 'POST'],
    allowedHeaders: ['authorization', 'content-type'],
  });
  app.get('/health', async () => ({ ok: true }));
  await authRoutes(app, deps);
  await signingRoutes(app, deps);
  return app;
}
