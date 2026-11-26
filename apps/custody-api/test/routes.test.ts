import { Keypair, Networks, TransactionBuilder, nativeToScVal, type Transaction } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INVESTOR_TAG } from '../src/custody/port.js';
import { GENERAL_DENIAL } from '../src/policy/evaluate.js';
import { CHANGED_TRANSACTION } from '../src/signing/envelope.js';
import { DEFAULT_REJECTED, PENDING_EXISTS } from '../src/signing/service.js';
import type { SignResult } from '../src/types.js';
import {
  DEAL,
  FRONT_ORIGIN,
  NOTE_TOKEN,
  NOW,
  addressArg,
  authenticationResponse,
  buildTx,
  changeTrustOp,
  claimOp,
  contractCall,
  createTestApp,
  eurc,
  register,
  registrationResponse,
  subscribeOp,
  toBase64,
  type TestContext,
} from './helpers.js';

let context: TestContext;

beforeEach(async () => {
  context = await createTestApp();
});

afterEach(async () => {
  await context.app.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function postSign(token: string, transaction: Transaction, networkPassphrase = Networks.TESTNET) {
  return context.app.inject({
    method: 'POST',
    url: '/sign',
    headers: bearer(token),
    payload: { transactionXdr: toBase64(transaction), networkPassphrase },
  });
}

async function getSign(token: string, requestId: string) {
  return context.app.inject({ method: 'GET', url: `/sign/${requestId}`, headers: bearer(token) });
}

function signatureIdOf(requestId: string): string {
  const record = context.store.signingRequests.get(requestId);
  if (!record) throw new Error(`no signing request ${requestId}`);
  return record.dfnsSignatureId;
}

describe('health and errors', () => {
  it('answers /health without a session', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('gives 401 unauthorized without a session', async () => {
    for (const request of [
      { method: 'GET' as const, url: '/me' },
      { method: 'POST' as const, url: '/sign', payload: {} },
      { method: 'GET' as const, url: '/sign/abc' },
    ]) {
      const response = await context.app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Log in with your passkey first.', code: 'unauthorized' });
    }
  });

  it('gives 401 for an unknown token', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/me', headers: bearer('not-a-token') });
    expect(response.statusCode).toBe(401);
  });

  it('gives a readable 404 for an unknown route', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/nothing' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'This route does not exist.', code: 'not_found' });
  });

  it('allows CORS for the front origin only', async () => {
    const preflight = (origin: string) =>
      context.app.inject({
        method: 'OPTIONS',
        url: '/sign',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
    const allowed = await preflight(FRONT_ORIGIN);
    expect(allowed.headers['access-control-allow-origin']).toBe(FRONT_ORIGIN);
    expect(String(allowed.headers['access-control-allow-headers'])).toContain('authorization');
    const other = await preflight('https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('passkey registration and login', () => {
  it('registers an investor, creates a tagged Dfns wallet, funds it and opens a session', async () => {
    const { token, investor } = await register(context.app, 'cred-1', 'Investor A');
    const wallet = context.custody.keys.get('key-1');
    expect(wallet?.tags).toEqual([INVESTOR_TAG]);
    expect(wallet?.name).toBe(`investor ${investor.id}`);
    expect(investor).toEqual({
      id: investor.id,
      displayName: 'Investor A',
      address: wallet?.wallet.address,
      walletId: 'wa-1',
      network: 'testnet',
    });
    expect(context.funder.funded).toEqual([investor.address]);
    const me = await context.app.inject({ method: 'GET', url: '/me', headers: bearer(token) });
    expect(me.json()).toEqual({ investor });
  });

  it('stores only the SHA-256 of the session token', async () => {
    const { token } = await register(context.app, 'cred-1');
    const [stored] = [...context.store.sessions.keys()];
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(token);
  });

  it('refuses a display name that is empty or too long', async () => {
    for (const displayName of ['', 'x'.repeat(65)]) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/auth/register/options',
        payload: { displayName },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('bad_request');
    }
  });

  it('uses a challenge only once', async () => {
    const options = await context.app.inject({
      method: 'POST',
      url: '/auth/register/options',
      payload: { displayName: 'Investor B' },
    });
    const { challengeId, options: creation } = options.json();
    const payload = { challengeId, response: registrationResponse('cred-2', creation.challenge) };
    const first = await context.app.inject({ method: 'POST', url: '/auth/register/verify', payload });
    const second = await context.app.inject({ method: 'POST', url: '/auth/register/verify', payload });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(410);
    expect(second.json().code).toBe('expired');
  });

  it('refuses a challenge after 5 minutes', async () => {
    const options = await context.app.inject({
      method: 'POST',
      url: '/auth/register/options',
      payload: { displayName: 'Investor B' },
    });
    const { challengeId, options: creation } = options.json();
    context.clock.now = new Date(NOW.getTime() + 5 * 60 * 1000 + 1);
    const response = await context.app.inject({
      method: 'POST',
      url: '/auth/register/verify',
      payload: { challengeId, response: registrationResponse('cred-2', creation.challenge) },
    });
    expect(response.statusCode).toBe(410);
    expect(context.custody.keys.size).toBe(0);
  });

  it('refuses a response signed for another challenge', async () => {
    const options = await context.app.inject({
      method: 'POST',
      url: '/auth/register/options',
      payload: { displayName: 'Investor B' },
    });
    const { challengeId } = options.json();
    const response = await context.app.inject({
      method: 'POST',
      url: '/auth/register/verify',
      payload: { challengeId, response: registrationResponse('cred-2', 'another-challenge') },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'The passkey could not be verified.', code: 'unauthorized' });
  });

  it('logs in with a discoverable passkey and updates the counter', async () => {
    const { investor } = await register(context.app, 'cred-1');
    const options = await context.app.inject({ method: 'POST', url: '/auth/login/options', payload: {} });
    const { challengeId, options: request } = options.json();
    expect(request.allowCredentials).toBeUndefined();
    const login = await context.app.inject({
      method: 'POST',
      url: '/auth/login/verify',
      payload: { challengeId, response: authenticationResponse('cred-1', request.challenge) },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().investor).toEqual(investor);
    expect(context.store.passkeys.get('cred-1')?.counter).toBe(1);
  });

  it('refuses a login with an unknown passkey', async () => {
    const options = await context.app.inject({ method: 'POST', url: '/auth/login/options' });
    const { challengeId, options: request } = options.json();
    const login = await context.app.inject({
      method: 'POST',
      url: '/auth/login/verify',
      payload: { challengeId, response: authenticationResponse('cred-x', request.challenge) },
    });
    expect(login.statusCode).toBe(401);
  });

  it('ends the session on logout, with or without a JSON body', async () => {
    const { token } = await register(context.app, 'cred-1');
    const logout = await context.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...bearer(token), 'content-type': 'application/json' },
    });
    expect(logout.statusCode).toBe(204);
    const me = await context.app.inject({ method: 'GET', url: '/me', headers: bearer(token) });
    expect(me.statusCode).toBe(401);
  });

  it('expires the session after SESSION_TTL_HOURS', async () => {
    const { token } = await register(context.app, 'cred-1');
    context.clock.now = new Date(NOW.getTime() + 12 * 3_600_000);
    const me = await context.app.inject({ method: 'GET', url: '/me', headers: bearer(token) });
    expect(me.statusCode).toBe(401);
    expect(me.json().error).toBe('Your session has expired. Log in again.');
  });

  it('gives a readable 502 when Friendbot fails, and keeps the investor for a later login', async () => {
    context.funder.fail = true;
    const options = await context.app.inject({
      method: 'POST',
      url: '/auth/register/options',
      payload: { displayName: 'Investor C' },
    });
    const { challengeId, options: creation } = options.json();
    const response = await context.app.inject({
      method: 'POST',
      url: '/auth/register/verify',
      payload: { challengeId, response: registrationResponse('cred-3', creation.challenge) },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe('custody_unavailable');
    expect(response.json().error).toContain('Friendbot did not fund it');
    expect(context.store.investors.size).toBe(1);
  });

  it('gives 502 custody_unavailable when Dfns cannot create the wallet', async () => {
    context.custody.failCreateWallet = true;
    const options = await context.app.inject({
      method: 'POST',
      url: '/auth/register/options',
      payload: { displayName: 'Investor D' },
    });
    const { challengeId, options: creation } = options.json();
    const response = await context.app.inject({
      method: 'POST',
      url: '/auth/register/verify',
      payload: { challengeId, response: registrationResponse('cred-4', creation.challenge) },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: 'The custody provider could not create the wallet. Try again later.',
      code: 'custody_unavailable',
    });
    expect(context.store.investors.size).toBe(0);
  });
});

describe('POST /sign and GET /sign/:requestId', () => {
  it('refuses a policy-denied transaction with 422 not_allowed and the reason, before Dfns', async () => {
    const { token, investor } = await register(context.app, 'cred-1');
    const args = [addressArg(investor.address), addressArg(Keypair.random().publicKey()), nativeToScVal(1n, { type: 'i128' })];
    const response = await postSign(token, buildTx(investor.address, [contractCall(NOTE_TOKEN, 'transfer', args)]));
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: GENERAL_DENIAL, code: 'not_allowed' });
    expect(context.custody.signatures.size).toBe(0);
  });

  it('refuses a transaction for another network with 422', async () => {
    const { token, investor } = await register(context.app, 'cred-1');
    const transaction = buildTx(investor.address, [claimOp(investor.address)], { networkPassphrase: Networks.PUBLIC });
    const response = await postSign(token, transaction, Networks.PUBLIC);
    expect(response.statusCode).toBe(422);
  });

  it('refuses an XDR that cannot be decoded with 400', async () => {
    const { token } = await register(context.app, 'cred-1');
    const response = await context.app.inject({
      method: 'POST',
      url: '/sign',
      headers: bearer(token),
      payload: { transactionXdr: 'bm90IGFuIGVudmVsb3Bl', networkPassphrase: Networks.TESTNET },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'The transaction XDR cannot be decoded.', code: 'bad_request' });
  });

  it('starts a pending request, then returns the signed envelope after the hash check', async () => {
    const { token, investor } = await register(context.app, 'cred-1');
    const transaction = buildTx(investor.address, [subscribeOp(investor.address, 2n)]);
    const started = await postSign(token, transaction);
    expect(started.statusCode).toBe(200);
    const pending = started.json<SignResult>();
    expect(pending).toEqual({
      requestId: pending.requestId,
      status: 'pending',
      approvalId: 'ap-2',
      decision: 'auto',
      summary: {
        kind: 'subscribe',
        contractId: DEAL.dealContractId,
        classIndex: 0,
        notes: '2',
        amountEurc: '200',
      },
    });
    const sent = context.custody.signatures.get(signatureIdOf(pending.requestId));
    expect(sent?.transactionHex).toBe(`0x${transaction.toEnvelope().toXDR('hex')}`);
    expect(sent?.externalId).toBe(pending.requestId);

    const stillPending = await getSign(token, pending.requestId);
    expect(stillPending.json<SignResult>().status).toBe('pending');

    context.custody.sign(signatureIdOf(pending.requestId));
    const signed = (await getSign(token, pending.requestId)).json<SignResult>();
    expect(signed.status).toBe('signed');
    const decoded = TransactionBuilder.fromXDR(signed.signedTxXdr ?? '', Networks.TESTNET) as Transaction;
    expect(decoded.hash().equals(transaction.hash())).toBe(true);
    const keypair = context.custody.keypairOf(investor.address);
    expect(keypair.verify(decoded.hash(), decoded.signatures[0]?.signature() ?? Buffer.alloc(0))).toBe(true);
  });

  it('accepts a 0x-less signedData too', async () => {
    const { token, investor } = await register(context.app, 'cred-1');
    const started = (await postSign(token, buildTx(investor.address, [claimOp(investor.address)]))).json<SignResult>();
    const signatureId = signatureIdOf(started.requestId);
    context.custody.sign(signatureId);
    const record = context.custody.signatures.get(signatureId);
    if (record?.state.signedData) record.state.signedData = record.state.signedData.slice(2);
    expect((await getSign(token, started.requestId)).json<SignResult>().status).toBe('signed');
  });

  it('marks the request failed when Dfns returns a changed body', async () => {
    const { token, investor } = await register(context.app, 'cred-1');
    const started = (await postSign(token, buildTx(investor.address, [claimOp(investor.address)]))).json<SignResult>();
    context.custody.sign(signatureIdOf(started.requestId), (prepared) =>
      TransactionBuilder.cloneFrom(prepared, { fee: '200000' }).build(),
    );
    const result = (await getSign(token, started.requestId)).json<SignResult>();
    expect(result.status).toBe('failed');
    expect(result.reason).toBe(CHANGED_TRANSACTION);
    expect(result.signedTxXdr).toBeUndefined();
    const again = (await getSign(token, started.requestId)).json<SignResult>();
    expect(again.status).toBe('failed');
  });

  it('refuses a second request while the first is pending, then accepts it after the signature', async () => {
    const { token, investor } = await register(context.app, 'cred-1');
    const first = (await postSign(token, buildTx(investor.address, [claimOp(investor.address)]))).json<SignResult>();
    const second = await postSign(token, buildTx(investor.address, [changeTrustOp(eurc(), '1000')]));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: PENDING_EXISTS, code: 'pending_exists' });

    context.custody.sign(signatureIdOf(first.requestId));
    const third = await postSign(token, buildTx(investor.address, [changeTrustOp(eurc(), '1000')]));
    expect(third.statusCode).toBe(200);
    expect(third.json<SignResult>().summary).toEqual({ kind: 'change_trust', limit: '1000.0000000' });
  });

  it('reports needs_approval for a subscribe above the threshold', async () => {
    const { token, investor } = await register(context.app, 'cred-1');
    const response = await postSign(token, buildTx(investor.address, [subscribeOp(investor.address, 3n)]));
    expect(response.json<SignResult>()).toMatchObject({ status: 'pending', decision: 'needs_approval' });
  });

  it('maps a Dfns rejection to rejected and keeps the Dfns reason', async () => {
    const { token, investor } = await register(context.app, 'cred-1');
    const started = (await postSign(token, buildTx(investor.address, [subscribeOp(investor.address, 3n)]))).json<SignResult>();
    context.custody.setStatus(signatureIdOf(started.requestId), 'Rejected', 'The approver denied the request.');
    const result = (await getSign(token, started.requestId)).json<SignResult>();
    expect(result).toMatchObject({ status: 'rejected', reason: 'The approver denied the request.' });
  });

  it('gives a default reason when Dfns rejects without one, and frees the slot', async () => {
    const { token, investor } = await register(context.app, 'cred-1');
    const started = (await postSign(token, buildTx(investor.address, [claimOp(investor.address)]))).json<SignResult>();
    context.custody.setStatus(signatureIdOf(started.requestId), 'Rejected');
    const next = await postSign(token, buildTx(investor.address, [claimOp(investor.address)]));
    expect(next.statusCode).toBe(200);
    const result = (await getSign(token, started.requestId)).json<SignResult>();
    expect(result).toMatchObject({ status: 'rejected', reason: DEFAULT_REJECTED });
  });

  it('maps a Dfns failure to failed with the Dfns reason', async () => {
    const { token, investor } = await register(context.app, 'cred-1');
    const started = (await postSign(token, buildTx(investor.address, [claimOp(investor.address)]))).json<SignResult>();
    context.custody.setStatus(signatureIdOf(started.requestId), 'Failed', 'Key share unavailable.');
    const result = (await getSign(token, started.requestId)).json<SignResult>();
    expect(result).toMatchObject({ status: 'failed', reason: 'Key share unavailable.' });
  });

  it('gives 404 for a request of another investor', async () => {
    const first = await register(context.app, 'cred-a', 'Investor A');
    const second = await register(context.app, 'cred-b', 'Investor B');
    const started = (await postSign(first.token, buildTx(first.investor.address, [claimOp(first.investor.address)]))).json<SignResult>();
    const response = await getSign(second.token, started.requestId);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'This signature request does not exist.', code: 'not_found' });
    expect((await getSign(first.token, started.requestId)).statusCode).toBe(200);
  });

  it('refuses a transaction that uses the wallet of another investor', async () => {
    const first = await register(context.app, 'cred-a', 'Investor A');
    const second = await register(context.app, 'cred-b', 'Investor B');
    const response = await postSign(second.token, buildTx(first.investor.address, [claimOp(first.investor.address)]));
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('The transaction source must be your wallet.');
  });

  it('gives 502 custody_unavailable when Dfns cannot start the request', async () => {
    const { token, investor } = await register(context.app, 'cred-1');
    context.custody.failSignature = true;
    const response = await postSign(token, buildTx(investor.address, [claimOp(investor.address)]));
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe('custody_unavailable');
    expect(context.store.signingRequests.size).toBe(0);
  });

  it('serializes two parallel requests of one investor: one passes, one gets 409', async () => {
    const { token, investor } = await register(context.app, 'cred-1');
    const [a, b] = await Promise.all([
      postSign(token, buildTx(investor.address, [claimOp(investor.address)])),
      postSign(token, buildTx(investor.address, [changeTrustOp(eurc())])),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });
});
