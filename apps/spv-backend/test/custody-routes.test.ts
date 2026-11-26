import { describe, expect, it } from 'vitest';
import type { Keypair, Transaction } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { environment } from '../src/config.js';
import { DfnsCustody } from '../src/custody/dfns.js';
import { DIFFERENT_TRANSACTION } from '../src/custody/errors.js';
import { EXPIRED, Operator } from '../src/custody/operator.js';
import type { Operation } from '../src/custody/operations.js';
import type { OperatorRole } from '../src/custody/ports.js';
import { buildServer } from '../src/server.js';
import { waterfallState } from '../src/waterfall/routes.js';
import { FakeNetwork, TEST_EURC, fakeServices, type SigningMode } from './support/fakes.js';

const passphrase = environment.NETWORK_PASSPHRASE;

async function serverWith(modes: Partial<Record<OperatorRole, SigningMode>> = {}) {
  const fakes = fakeServices(modes);
  const app = await buildServer(fakes.services);
  return { ...fakes, app };
}

async function post(app: FastifyInstance, url: string, payload?: object) {
  const response = await app.inject({ method: 'POST', url, ...(payload ? { payload } : {}) });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function getOperation(app: FastifyInstance, id: string) {
  const response = await app.inject({ method: 'GET', url: `/operations/${id}` });
  return { status: response.statusCode, body: response.json() as Operation };
}

function secondsValid(transaction: Transaction | undefined): number {
  const maxTime = Number(transaction?.timeBounds?.maxTime ?? 0);
  return maxTime - Math.floor(Date.now() / 1000);
}

function signedBy(transaction: Transaction | undefined, keypair: Keypair): boolean {
  if (!transaction) return false;
  const hash = transaction.hash();
  return transaction.signatures.some((signature) => keypair.verify(hash, signature.signature()));
}

describe('operator custody: signed at once', () => {
  it('closes the deal with the admin wallet and answers 200 with the hash', async () => {
    const { app, network, custody } = await serverWith();
    const response = await post(app, '/waterfall/close-deal');
    expect(response.status).toBe(200);
    expect(response.body.closed).toBe(true);
    expect(network.methods()).toEqual(['close']);
    const submitted = network.submitted[0]?.transaction;
    expect(submitted?.source).toBe(custody.address('admin'));
    expect(signedBy(submitted, custody.keypairs.admin)).toBe(true);
    expect(response.body.transactionHash).toBe(submitted?.hash().toString('hex'));
    // An approval can take time: the admin transaction stays valid for one hour.
    expect(secondsValid(submitted)).toBeGreaterThan(3500);
    expect(custody.externalIds[0]?.length).toBeLessThanOrEqual(50);
    const list = await app.inject({ method: 'GET', url: '/operations' });
    const { operations } = list.json() as { operations: Operation[] };
    expect(operations[0]).toMatchObject({ status: 'done', role: 'admin', method: 'close' });
  });

  it('refuses a signed transaction whose body the custody provider changed', async () => {
    const { app, network } = await serverWith({ admin: 'tamper' });
    const response = await post(app, '/waterfall/close-deal');
    expect(response.status).toBe(502);
    expect(response.body.error).toBe(DIFFERENT_TRANSACTION);
    expect(network.submitted).toHaveLength(0);
  });

  it('gives 422 with the Dfns reason when the policy blocks the signature', async () => {
    const { app, network } = await serverWith({ admin: 'reject' });
    const response = await post(app, '/waterfall/close-deal');
    expect(response.status).toBe(422);
    expect(response.body.error).toBe(
      'The custody provider rejected the signature: Blocked by the policy of the wallet.',
    );
    expect(network.submitted).toHaveLength(0);
  });
});

describe('operator custody: signature that waits for an approval', () => {
  it('answers 202, then GET /operations/:id submits and runs the crank follow-up', async () => {
    const { app, network, custody } = await serverWith({ servicer: 'approval' });
    const response = await post(app, '/waterfall/run-period', { collectionsEurc: 12.5 });
    expect(response.status).toBe(202);
    const pending = response.body as unknown as Operation;
    expect(pending).toMatchObject({
      status: 'awaiting_approval',
      role: 'servicer',
      method: 'distribute',
      approvalId: 'ap-1',
    });

    const before = await getOperation(app, pending.id);
    expect(before.body.status).toBe('awaiting_approval');
    expect(network.submitted).toHaveLength(0);

    custody.approve(pending.signatureId ?? '');
    const after = await getOperation(app, pending.id);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('done');
    expect(network.methods()).toEqual(['distribute', 'push_batch', 'push_batch', 'push_batch']);
    const [distribute, ...pushes] = network.submitted;
    expect(distribute?.args).toEqual([3, 125_000_000n]);
    expect(distribute?.transaction.source).toBe(custody.address('servicer'));
    // push_batch goes to the paying agent of the deal wiring, not to the setting.
    expect(network.payingAgent).not.toBe(environment.PAYING_AGENT_CONTRACT_ID);
    for (const push of pushes) {
      expect(push.contractId).toBe(network.payingAgent);
      expect(push.transaction.source).toBe(custody.address('crank'));
      expect(secondsValid(push.transaction)).toBeLessThanOrEqual(120);
    }
    expect(after.body.hash).toBe(distribute?.transaction.hash().toString('hex'));
    expect(after.body.result).toMatchObject({
      distributed: 12.5,
      distributedBaseUnits: '125000000',
      assetSymbol: 'EURC',
      collectionsSource: 'override',
      perClass: ['1', '2', '3'],
    });
    expect((after.body.result as { pushes: unknown[] }).pushes).toHaveLength(3);
  });

  it('reports the rejection with the reason of the approver', async () => {
    const { app, network, custody } = await serverWith({ servicer: 'approval' });
    const response = await post(app, '/waterfall/run-period', { collectionsEurc: 1 });
    const pending = response.body as unknown as Operation;
    custody.reject(pending.signatureId ?? '', 'The amount is not the agreed one.');
    const after = await getOperation(app, pending.id);
    expect(after.body.status).toBe('rejected');
    expect(after.body.error).toBe(
      'The custody provider rejected the signature: The amount is not the agreed one.',
    );
    expect(network.submitted).toHaveLength(0);
  });

  it('refuses a second pending operation on one role (409), then frees the role', async () => {
    const { app, custody } = await serverWith({ admin: 'approval' });
    const first = await post(app, '/waterfall/close-deal');
    expect(first.status).toBe(202);
    const second = await post(app, '/waterfall/close-deal');
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/same sequence number/);

    const pending = first.body as unknown as Operation;
    custody.reject(pending.signatureId ?? '', 'Not now.');
    await getOperation(app, pending.id);
    const third = await post(app, '/waterfall/close-deal');
    expect(third.status).toBe(202);
  });

  it('fails a pending operation after its time bound, so the role is free again', async () => {
    const fakes = fakeServices({ admin: 'approval' });
    let now = Date.now();
    const operator = new Operator({
      custody: fakes.custody,
      network: fakes.network,
      networkPassphrase: passphrase,
      now: () => now,
    });
    const app = await buildServer({ network: fakes.network, operator });
    const pending = (await post(app, '/waterfall/close-deal')).body as unknown as Operation;
    now += 3601 * 1000;
    const after = await getOperation(app, pending.id);
    expect(after.body).toMatchObject({ status: 'failed', error: EXPIRED });
    expect(operator.registry.activeFor('admin')).toBeUndefined();
  });
});

describe('run-period: amounts in the deal asset and any class count', () => {
  it('takes collections as a decimal string in units of the deal asset', async () => {
    const { app, network } = await serverWith();
    const response = await post(app, '/waterfall/run-period', { collections: '12.5' });
    expect(response.status).toBe(200);
    expect(network.submitted[0]?.args).toEqual([3, 125_000_000n]);
  });

  it('converts with the decimals of the asset and pushes each class of a 4-class deal', async () => {
    const fakes = fakeServices({}, { classCount: 4, decimals: 6 });
    const app = await buildServer(fakes.services);
    const response = await post(app, '/waterfall/run-period', { collections: '1234.567891' });
    expect(response.status).toBe(200);
    expect(fakes.network.methods()).toEqual(['distribute', ...Array.from({ length: 4 }, () => 'push_batch')]);
    expect(fakes.network.submitted[0]?.args).toEqual([3, 1_234_567_891n]);
    const pushed = fakes.network.submitted.slice(1).map((push) => push.args[1]);
    expect(pushed).toEqual([0, 1, 2, 3]);
    expect(response.body).toMatchObject({
      distributed: 1234.567891,
      distributedBaseUnits: '1234567891',
      perClass: ['1', '2', '3', '4'],
    });
  });

  it('refuses more decimals than the asset has, and both amount forms in one body', async () => {
    const { app, network } = await serverWith();
    const tooFine = await post(app, '/waterfall/run-period', { collections: '1.12345678' });
    expect(tooFine).toMatchObject({ status: 400, body: { error: 'collections "1.12345678" has more than 7 decimals.' } });
    const both = await post(app, '/waterfall/run-period', { collections: '1', collectionsEurc: 1 });
    expect(both.status).toBe(400);
    expect(both.body.error).toMatch(/not both/);
    expect(network.submitted).toHaveLength(0);
  });

  it('gives 409 when the deal is not wired', async () => {
    const { app, network } = await serverWith();
    network.wired = false;
    expect(await post(app, '/waterfall/run-period', { collections: '1' })).toMatchObject({
      status: 409,
      body: { error: 'Deal not wired' },
    });
    expect((await post(app, '/waterfall/push-distribution', {})).status).toBe(409);
    expect(network.submitted).toHaveLength(0);
  });
});

describe('waterfall view', () => {
  it('divides the amounts by the decimals of the deal asset, read once', async () => {
    const agent = 'CAXBYHZVHXOP3HQCMXPPVZMDUYEO27CTQQQDMWVNMMGSRCBSJHGIARZW';
    const answers: Record<string, unknown> = {
      get_config: {
        asset: TEST_EURC.sac,
        days_in_period: 90,
        note_denomination: 10_000_000n,
        classes: [
          { rate: ['Floating', 600n], total_notes: 4n },
          { rate: ['Fixed', 1500n], total_notes: 3n },
        ],
      },
      name: TEST_EURC.name,
      symbol: 'EURC',
      decimals: 6,
      get_state: 'Amortizing',
      get_reserve: 5_000_000n,
      get_carry: 1n,
      get_note_factors: [10_000_000n, 10_000_000n],
      get_outstanding: [40_000_000n, 30_000_000n],
      get_shortfalls: [0n, 0n],
      get_next_period: 2,
      get_wiring: { note_tokens: [agent, agent], paying_agent: agent },
      lastprice: { price: 2_000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) },
      balance: 2_500_000n,
      get_alloc: { interest_pot: 100n, principal: 0n, per_note_principal: 0n, cursor: 1, holder_count: 1, done: true },
    };
    let decimalReads = 0;
    const read = async (_contractId: string, method: string): Promise<unknown> => {
      if (method === 'decimals') decimalReads += 1;
      return answers[method];
    };
    const view = await waterfallState(read);
    await waterfallState(read);
    expect(decimalReads).toBe(1);
    expect(view.asset).toEqual({ contractId: TEST_EURC.sac, symbol: 'EURC', decimals: 6 });
    expect(view).toMatchObject({ reserveEurc: 5, carryEurc: 0.000001, outstandingEurc: [40, 30], principalRepaidEurc: [0, 0] });
    // A: 40 x (2.000 % + 0.600 %) x 90 / 360 = 0.26. B: 30 x 1.500 % x 90 / 360 = 0.1125.
    expect(view.nextInterestEurc).toEqual([0.26, 0.1125]);
    expect(view.payingAgent).toMatchObject({ contractId: agent, balanceEurc: 2.5, lastPeriod: 1 });
    expect(view.payingAgent?.allocs[0]).toMatchObject({ interestEurc: 0.0001, pushed: true });
  });
});

describe('operator custody: HTTP input and configuration', () => {
  it('validates the run-period body', async () => {
    const { app } = await serverWith();
    expect((await post(app, '/waterfall/run-period', { collectionsEurc: -1 })).status).toBe(400);
    expect((await post(app, '/waterfall/run-period', { collections: 5 })).status).toBe(400);
    expect((await post(app, '/waterfall/run-period', { collections: '-1' })).status).toBe(400);
  });

  it('gives 404 for an unknown operation', async () => {
    const { app } = await serverWith();
    expect((await getOperation(app, 'op-unknown')).status).toBe(404);
  });

  it('starts read-only without Dfns settings and names the missing setting', async () => {
    const network = new FakeNetwork();
    const custody = new DfnsCustody({ DFNS_API_URL: 'https://api.dfns.io' }, passphrase);
    const operator = new Operator({ custody, network, networkPassphrase: passphrase });
    const app = await buildServer({ network, operator });
    const response = await post(app, '/waterfall/close-deal');
    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/^DFNS_ADMIN_WALLET_ID is not set/);
    expect(operator.registry.list()).toHaveLength(0);
  });
});
