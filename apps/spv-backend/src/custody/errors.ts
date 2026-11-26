/** An operator error with a readable sentence and the HTTP status to send. */
export class OperatorError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'OperatorError';
  }
}

/** A required setting is not set: the server stays read-only for this operation. */
export function missingSetting(name: string, purpose: string): OperatorError {
  return new OperatorError(`${name} is not set. Set it in .env to ${purpose}.`, 503);
}

export const DIFFERENT_TRANSACTION = 'The custody provider returned a different transaction.';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorStatus(error: unknown, fallback = 502): number {
  return error instanceof OperatorError ? error.statusCode : fallback;
}
