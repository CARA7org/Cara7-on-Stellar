import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppDependencies } from '../deps.js';
import { unauthorized } from '../errors.js';
import type { InvestorRecord } from '../store/port.js';
import type { InvestorView, SessionView } from '../types.js';

/// The service stores only this hash. A database leak gives no usable token.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1] ?? null;
}

export async function openSession(
  deps: AppDependencies,
  investor: InvestorRecord,
): Promise<SessionView> {
  const sessionToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(deps.now().getTime() + deps.sessionTtlHours * 3_600_000);
  await deps.store.createSession({ tokenHash: hashToken(sessionToken), investorId: investor.id, expiresAt });
  return { sessionToken, expiresAt: expiresAt.toISOString(), investor: toInvestorView(investor) };
}

/// Gives the investor of the bearer session, or throws 401.
export async function authenticate(
  request: FastifyRequest,
  deps: AppDependencies,
): Promise<InvestorRecord> {
  const token = bearerToken(request);
  if (token === null) throw unauthorized();
  const tokenHash = hashToken(token);
  const session = await deps.store.findSession(tokenHash);
  if (session === null) throw unauthorized();
  if (session.expiresAt <= deps.now()) {
    await deps.store.deleteSession(tokenHash);
    throw unauthorized('Your session has expired. Log in again.');
  }
  const investor = await deps.store.findInvestor(session.investorId);
  if (investor === null) throw unauthorized();
  return investor;
}

export function toInvestorView(investor: InvestorRecord): InvestorView {
  return {
    id: investor.id,
    displayName: investor.displayName,
    address: investor.address,
    walletId: investor.walletId,
    network: investor.network,
  };
}
