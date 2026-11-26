// Every 4xx and 5xx answer has the body { error: "<readable sentence>", code }.

export type ErrorCode =
  | 'unauthorized'
  | 'bad_request'
  | 'not_found'
  | 'not_allowed'
  | 'pending_exists'
  | 'expired'
  | 'custody_unavailable'
  | 'internal_error';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/// A call to the custody provider (Dfns) or to Friendbot failed.
export class CustodyUnavailableError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'CustodyUnavailableError';
  }
}

export const unauthorized = (message = 'Log in with your passkey first.'): HttpError =>
  new HttpError(401, 'unauthorized', message);

export const badRequest = (message: string): HttpError => new HttpError(400, 'bad_request', message);

export const notFound = (message: string): HttpError => new HttpError(404, 'not_found', message);
