import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/sessions.js';
import type { AppDependencies } from '../deps.js';
import { parseInput } from '../http.js';
import type { SignResult } from '../types.js';
import { KeyedLock } from './lock.js';
import { refreshSigning, startSigning } from './service.js';

const signBody = z.object({
  transactionXdr: z.string().min(1).max(200_000),
  networkPassphrase: z.string().min(1),
});
const signParams = z.object({ requestId: z.string().min(1).max(100) });

/// Signature requests. Every route needs a session.
export async function signingRoutes(app: FastifyInstance, deps: AppDependencies): Promise<void> {
  const lock = new KeyedLock();

  app.post('/sign', async (request): Promise<SignResult> => {
    const investor = await authenticate(request, deps);
    const body = parseInput(signBody, request.body);
    return lock.run(investor.id, () => startSigning(deps, investor, body));
  });

  app.get('/sign/:requestId', async (request): Promise<SignResult> => {
    const investor = await authenticate(request, deps);
    const { requestId } = parseInput(signParams, request.params);
    return refreshSigning(deps, investor, requestId);
  });
}
