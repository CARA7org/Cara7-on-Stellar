import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { errorMessage, errorStatus } from './errors.js';
import type { Operation } from './operations.js';
import type { Operator } from './operator.js';

/**
 * HTTP view of the operator operations.
 *
 * - done: 200 with the result of the operation.
 * - awaiting_approval or submitting: 202 with the operation.
 * - rejected: 422 with `{ error, operation }`.
 * - failed: 502 with `{ error, operation }`.
 */
export function sendOperation(reply: FastifyReply, operation: Operation): FastifyReply {
  switch (operation.status) {
    case 'done':
      return reply.status(200).send(operation.result);
    case 'awaiting_approval':
    case 'submitting':
      return reply.status(202).send(operation);
    case 'rejected':
      return reply.status(422).send({ error: operation.error, operation });
    case 'failed':
      return reply.status(502).send({ error: operation.error, operation });
  }
}

export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  return reply.status(errorStatus(error)).send({ error: errorMessage(error) });
}

const paramsSchema = z.object({ id: z.string().min(1) });

/**
 * GET /operations lists the operations of this process, newest first.
 * GET /operations/:id polls the custody provider once for a pending
 * operation. When the signature is there, it submits the transaction and
 * runs the follow-up. The server has no background loop.
 */
export function operationRoutes(operator: Operator): FastifyPluginAsync {
  return async (app) => {
    app.get('/operations', async () => ({ operations: operator.registry.list() }));

    app.get('/operations/:id', async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: 'The operation id is missing.' });
      try {
        return await operator.refresh(params.data.id);
      } catch (error) {
        return sendError(reply, error);
      }
    });
  };
}
