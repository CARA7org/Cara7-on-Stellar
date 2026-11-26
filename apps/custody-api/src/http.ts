import type { FastifyError, FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { AppLogger } from './deps.js';
import { CustodyUnavailableError, HttpError, badRequest } from './errors.js';

/// Validates a body or a params object with Zod. A failure gives 400 bad_request.
export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
  throw badRequest(`The request is not valid${where}: ${issue?.message ?? 'unknown error'}.`);
}

/// Every 4xx and 5xx answer has the body { error, code }.
export function installErrorHandling(app: FastifyInstance, log: AppLogger): void {
  app.setErrorHandler((error: FastifyError | Error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    }
    if (error instanceof CustodyUnavailableError) {
      log.error(`[custody] ${error.message}`, error.detail);
      return reply
        .code(502)
        .send({ error: `${error.message} Try again later.`, code: 'custody_unavailable' });
    }
    const statusCode = 'statusCode' in error ? error.statusCode : undefined;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply
        .code(statusCode)
        .send({ error: `The request is not valid: ${error.message}`, code: 'bad_request' });
    }
    log.error('[custody-api] internal error', error);
    return reply
      .code(500)
      .send({ error: 'The custody service had an internal error.', code: 'internal_error' });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'This route does not exist.', code: 'not_found' }),
  );
}

/// The default JSON parser refuses an empty body. This one reads it as {}.
export function acceptEmptyJson(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, {});
      return;
    }
    parseJson(request, text, done);
  });
}
