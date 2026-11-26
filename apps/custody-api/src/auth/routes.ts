import { randomUUID } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INVESTOR_TAG } from '../custody/port.js';
import type { AppDependencies } from '../deps.js';
import { HttpError, badRequest, unauthorized } from '../errors.js';
import { FundingError } from '../funding/friendbot.js';
import { parseInput } from '../http.js';
import type { ChallengeKind, ChallengeRecord, InvestorRecord } from '../store/port.js';
import type { SessionView } from '../types.js';
import { CHALLENGE_TTL_MS } from './passkeys.js';
import { authenticate, bearerToken, hashToken, openSession, toInvestorView } from './sessions.js';

const registerOptionsBody = z.object({ displayName: z.string().trim().min(1).max(64) });

const credentialBase = {
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  clientExtensionResults: z.looseObject({}),
};
const registerVerifyBody = z.object({
  challengeId: z.string().min(1),
  response: z.looseObject({
    ...credentialBase,
    response: z.looseObject({ clientDataJSON: z.string(), attestationObject: z.string() }),
  }),
});
const loginVerifyBody = z.object({
  challengeId: z.string().min(1),
  response: z.looseObject({
    ...credentialBase,
    response: z.looseObject({
      clientDataJSON: z.string(),
      authenticatorData: z.string(),
      signature: z.string(),
    }),
  }),
});

/// Passkey registration, login and logout need no session. /me needs one.
export async function authRoutes(app: FastifyInstance, deps: AppDependencies): Promise<void> {
  registrationRoutes(app, deps);
  loginRoutes(app, deps);

  app.post('/auth/logout', async (request, reply) => {
    const token = bearerToken(request);
    if (token !== null) await deps.store.deleteSession(hashToken(token));
    return reply.code(204).send();
  });

  app.get('/me', async (request) => {
    const investor = await authenticate(request, deps);
    return { investor: toInvestorView(investor) };
  });
}

function registrationRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.post('/auth/register/options', async (request) => {
    const { displayName } = parseInput(registerOptionsBody, request.body);
    const options = await deps.passkeys.registrationOptions({ displayName });
    const challengeId = await saveChallenge(deps, 'register', options.challenge, displayName);
    return { challengeId, options };
  });

  app.post('/auth/register/verify', async (request): Promise<SessionView> => {
    const body = parseInput(registerVerifyBody, request.body);
    const challenge = await consumeChallenge(deps, body.challengeId, 'register');
    const response = body.response as RegistrationResponseJSON;
    const passkey = await deps.passkeys.verifyRegistration({
      response,
      expectedChallenge: challenge.challenge,
    });
    if (passkey === null) throw unauthorized('The passkey could not be verified.');
    if ((await deps.store.findPasskey(passkey.credentialId)) !== null) {
      throw badRequest('This passkey is already registered. Log in instead.');
    }
    const investor = await createInvestor(deps, challenge.displayName ?? 'Investor', passkey);
    await fundWallet(deps, investor);
    return openSession(deps, investor);
  });
}

function loginRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.post('/auth/login/options', async () => {
    const options = await deps.passkeys.authenticationOptions();
    const challengeId = await saveChallenge(deps, 'login', options.challenge, null);
    return { challengeId, options };
  });

  app.post('/auth/login/verify', async (request): Promise<SessionView> => {
    const body = parseInput(loginVerifyBody, request.body);
    const challenge = await consumeChallenge(deps, body.challengeId, 'login');
    const response = body.response as AuthenticationResponseJSON;
    const passkey = await deps.store.findPasskey(response.id);
    if (passkey === null) throw unauthorized('This passkey is not registered. Create an account first.');
    const verified = await deps.passkeys.verifyAuthentication({
      response,
      expectedChallenge: challenge.challenge,
      credential: passkey,
    });
    if (verified === null) throw unauthorized('The passkey could not be verified.');
    await deps.store.updatePasskeyCounter(passkey.id, verified.newCounter);
    const investor = await deps.store.findInvestor(passkey.investorId);
    if (investor === null) throw unauthorized('This passkey has no investor account.');
    return openSession(deps, investor);
  });
}

async function saveChallenge(
  deps: AppDependencies,
  kind: ChallengeKind,
  challenge: string,
  displayName: string | null,
): Promise<string> {
  const now = deps.now();
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  await deps.store.saveChallenge({ id, kind, challenge, displayName, expiresAt }, now);
  return id;
}

/// A challenge works once: the store removes it before the verification.
async function consumeChallenge(
  deps: AppDependencies,
  id: string,
  kind: ChallengeKind,
): Promise<ChallengeRecord> {
  const challenge = await deps.store.takeChallenge(id);
  if (challenge === null || challenge.expiresAt <= deps.now()) {
    throw new HttpError(410, 'expired', 'The passkey challenge has expired or was already used. Start again.');
  }
  if (challenge.kind !== kind) throw badRequest('This passkey challenge is for another step.');
  return challenge;
}

/// Creates the Dfns wallet first, then stores the investor and the passkey.
async function createInvestor(
  deps: AppDependencies,
  displayName: string,
  passkey: { credentialId: string; publicKey: Uint8Array; counter: number; transports: string[] },
): Promise<InvestorRecord> {
  const investorId = randomUUID();
  const wallet = await deps.custody.createWallet({
    name: `investor ${investorId}`,
    tags: [INVESTOR_TAG],
  });
  return deps.store.createInvestor(
    { id: investorId, displayName, ...wallet, network: deps.network },
    {
      id: passkey.credentialId,
      investorId,
      publicKey: passkey.publicKey,
      counter: passkey.counter,
      transports: passkey.transports,
    },
  );
}

async function fundWallet(deps: AppDependencies, investor: InvestorRecord): Promise<void> {
  try {
    await deps.funder.fund(investor.address);
  } catch (error) {
    if (!(error instanceof FundingError)) throw error;
    deps.log.error(`[friendbot] ${investor.address}: ${error.message}`);
    throw new HttpError(
      502,
      'custody_unavailable',
      `Your wallet ${investor.address} exists, but Friendbot did not fund it. Fund it with Friendbot, then log in with your passkey.`,
    );
  }
}
