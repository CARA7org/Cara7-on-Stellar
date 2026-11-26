import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { nextFreeClassIndex } from '../src/registry.js';

const TEST_DEAL_NAME = 'Deal de test vitest cara7';
const TEST_CONTRACT_ID = 'C' + 'A'.repeat(55);
const UNKNOWN_CONTRACT_ID = 'C' + 'B'.repeat(55);
// More note contracts of the test deal. The deal cleanup removes them (cascade).
const CLASS_3_CONTRACT_ID = 'C' + 'F'.repeat(55);
const MEZZANINE_1_CONTRACT_ID = 'C' + 'G'.repeat(55);
const MEZZANINE_2_CONTRACT_ID = 'C' + 'H'.repeat(55);
// Never stored: the registry refuses it.
const REFUSED_CONTRACT_ID = 'C' + 'I'.repeat(55);

interface TrancheBody {
  tranche: { classIndex: number; rateKind: string; seniority: string; contractId: string };
}

/// One period of a vector of the abs-deal contract: real events of a real
/// payment date, in the form that the indexer stores.
interface VectorPeriod {
  period: number;
  collections: string;
  /// [rank id, [item name, index?], due, paid, dust]
  lines: [string, [string, number?], string, string, string][];
  settled: Record<string, string>;
  events: { topics: unknown[]; data: unknown[] }[];
}

/// The additions of the rank engine to a distribution row.
interface RankEngineRow {
  ranks: {
    rank: string;
    item: string;
    class: number | null;
    feeIndex: number | null;
    due: string;
    paid: string;
    dust: string;
  }[];
  settlement: (Record<string, string> & { conserved: boolean; covered: boolean }) | null;
  triggers: { id: string }[];
  parked: { recipient: string; rank: number; amount: string }[];
}

async function testDealId(): Promise<number> {
  const deal = await prisma.deal.findFirst({ where: { name: TEST_DEAL_NAME } });
  expect(deal).not.toBeNull();
  return deal!.id;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await prisma.deal.deleteMany({ where: { name: TEST_DEAL_NAME } });
});

afterAll(async () => {
  // Remove only the rows of this test (also when an assertion failed).
  await prisma.stellarEvent.deleteMany({ where: { contractId: UNKNOWN_CONTRACT_ID } });
  await prisma.tranche.deleteMany({ where: { contractId: TEST_CONTRACT_ID } });
  await prisma.deal.deleteMany({ where: { name: TEST_DEAL_NAME } });
  await app.close();
});

describe('/health', () => {
  it('answers ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});

describe('registre deals/tranches', () => {
  it('refuses a deal without a name', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/deals', payload: { name: '' } });
    expect(response.statusCode).toBe(400);
  });

  it('creates a deal, then refuses the duplicate', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/deals',
      payload: { name: TEST_DEAL_NAME, description: 'test' },
    });
    expect(created.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/deals',
      payload: { name: TEST_DEAL_NAME },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('refuses a tranche with an invalid contractId', async () => {
    const { deal } = (
      await app.inject({ method: 'GET', url: '/api/deals' })
    ).json<{ deals: { id: number; name: string }[] }>().deals.reduce(
      (accumulator, candidate) => (candidate.name === TEST_DEAL_NAME ? { deal: candidate } : accumulator),
      { deal: undefined as { id: number } | undefined },
    );
    expect(deal).toBeDefined();

    const response = await app.inject({
      method: 'POST',
      url: `/api/deals/${deal?.id}/tranches`,
      payload: {
        name: 'Tranche X',
        seniority: 'SENIOR',
        contractId: 'not-a-contract',
        originalFace: '1000000000000',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('registers a valid note tranche and lists it', async () => {
    const dealsResponse = await app.inject({ method: 'GET', url: '/api/deals' });
    const deal = dealsResponse
      .json<{ deals: { id: number; name: string; phase: string }[] }>()
      .deals.find((candidate) => candidate.name === TEST_DEAL_NAME);
    // A deal with no on-chain contract is deemed to be in FUNDING.
    expect(deal?.phase).toBe('FUNDING');

    const created = await app.inject({
      method: 'POST',
      url: `/api/deals/${deal?.id}/tranches`,
      payload: {
        name: 'Class T - Test Notes',
        seniority: 'JUNIOR',
        contractId: TEST_CONTRACT_ID,
        originalFace: '450000000000',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ tranche: { originalFace: string } }>().tranche.originalFace).toBe(
      '450000000000',
    );
    // No classIndex in the body: the first free index of the deal (0).
    // No rateKind in the body: FIXED.
    expect(created.json<TrancheBody>().tranche).toMatchObject({ classIndex: 0, rateKind: 'FIXED' });

    const list = await app.inject({ method: 'GET', url: '/api/tranches' });
    expect(list.statusCode).toBe(200);
    const { tranches } = list.json<{
      tranches: {
        contractId: string;
        originalFace: string;
        classIndex: number;
        rateKind: string;
        stats: { phase: string } | null;
      }[];
    }>();
    const testTranche = tranches.find((tranche) => tranche.contractId === TEST_CONTRACT_ID);
    expect(testTranche).toBeDefined();
    expect(testTranche?.originalFace).toBe('450000000000');
    expect(testTranche).toMatchObject({ classIndex: 0, rateKind: 'FIXED' });
    // No snapshot: nominal funding state, and no NAV anywhere.
    expect(testTranche?.stats?.phase).toBe('FUNDING');
  });

  it('registers the classIndex and the rateKind of the body', async () => {
    const dealId = await testDealId();
    const created = await app.inject({
      method: 'POST',
      url: `/api/deals/${dealId}/tranches`,
      payload: {
        name: 'Class D Notes',
        seniority: 'JUNIOR',
        classIndex: 3,
        rateKind: 'FLOATING',
        couponBps: 125,
        contractId: CLASS_3_CONTRACT_ID,
        originalFace: '100000000000',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<TrancheBody>().tranche).toMatchObject({
      classIndex: 3,
      rateKind: 'FLOATING',
      seniority: 'JUNIOR',
    });
  });

  it('refuses a duplicate classIndex of a deal with a 409', async () => {
    const dealId = await testDealId();
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/deals/${dealId}/tranches`,
      payload: {
        name: 'Class D2 Notes',
        seniority: 'JUNIOR',
        classIndex: 3,
        contractId: REFUSED_CONTRACT_ID,
        originalFace: '100000000000',
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ error: string }>().error).toBe(
      'Class index 3 is already used in this deal by "Class D Notes". Each class of a deal needs its own class index.',
    );
    expect(await prisma.tranche.findUnique({ where: { contractId: REFUSED_CONTRACT_ID } })).toBeNull();
  });

  it('refuses a classIndex outside 0 to 7', async () => {
    const dealId = await testDealId();
    for (const classIndex of [8, -1, 1.5]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/deals/${dealId}/tranches`,
        payload: {
          name: 'Class X Notes',
          seniority: 'JUNIOR',
          classIndex,
          contractId: REFUSED_CONTRACT_ID,
          originalFace: '100000000000',
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe('classIndex must be an integer from 0 to 7');
    }
  });

  it('takes the next free classIndex when the body has none', async () => {
    const dealId = await testDealId();
    // Classes 0 and 3 are taken: two MEZZANINE classes get the indexes 1 and 2.
    const registered: number[] = [];
    for (const [name, contractId] of [
      ['Class B1 Notes', MEZZANINE_1_CONTRACT_ID],
      ['Class B2 Notes', MEZZANINE_2_CONTRACT_ID],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/deals/${dealId}/tranches`,
        payload: { name, seniority: 'MEZZANINE', contractId, originalFace: '100000000000' },
      });
      expect(response.statusCode).toBe(201);
      registered.push(response.json<TrancheBody>().tranche.classIndex);
    }
    expect(registered).toEqual([1, 2]);

    // The deal lists its tranches in class order, senior first.
    const deals = (await app.inject({ method: 'GET', url: '/api/deals' })).json<{
      deals: { id: number; tranches: { classIndex: number; seniority: string; rateKind: string }[] }[];
    }>().deals;
    const tranches = deals.find((deal) => deal.id === dealId)?.tranches ?? [];
    expect(tranches.map((tranche) => [tranche.classIndex, tranche.seniority])).toEqual([
      [0, 'JUNIOR'],
      [1, 'MEZZANINE'],
      [2, 'MEZZANINE'],
      [3, 'JUNIOR'],
    ]);
    expect(tranches.every((tranche) => typeof tranche.rateKind === 'string')).toBe(true);
  });

  it('finds the next free classIndex, and none when a deal has 8 classes', () => {
    expect(nextFreeClassIndex([])).toBe(0);
    expect(nextFreeClassIndex([0, 3])).toBe(1);
    expect(nextFreeClassIndex([0, 1, 2, 3, 4, 5, 6, 7])).toBeNull();
  });

  it('answers 404 for a tranche that does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tranches/999999' });
    expect(response.statusCode).toBe(404);
  });

  it('groups the distributions by period', async () => {
    // Synthetic deal with an on-chain contract and v4 events in the database.
    const deal = await prisma.deal.findFirst({ where: { name: TEST_DEAL_NAME } });
    await prisma.deal.update({
      where: { id: deal!.id },
      data: { dealContractId: UNKNOWN_CONTRACT_ID },
    });
    await prisma.stellarEvent.createMany({
      data: [
        {
          id: '9000000000000001',
          ledger: 100,
          ts: new Date('2026-08-01T00:00:00Z'),
          contractId: UNKNOWN_CONTRACT_ID,
          type: 'distribution',
          topic: ['distribution', 1],
          data: ['99000000000', '50000000000', '0', '149000000000'],
        },
        {
          id: '9000000000000002',
          ledger: 100,
          ts: new Date('2026-08-01T00:00:00Z'),
          contractId: UNKNOWN_CONTRACT_ID,
          type: 'interest_paid',
          topic: ['interest_paid', 0],
          data: ['1', '234083333', '234083000', '0', '333'],
        },
        {
          id: '9000000000000003',
          ledger: 100,
          ts: new Date('2026-08-01T00:00:00Z'),
          contractId: UNKNOWN_CONTRACT_ID,
          type: 'principal_paid',
          topic: ['principal_paid', 0],
          data: ['1', '98151333000', '98151333', '901848667000'],
        },
        {
          id: '9000000000000004',
          ledger: 100,
          ts: new Date('2026-08-01T00:00:00Z'),
          contractId: UNKNOWN_CONTRACT_ID,
          type: 'reserve_refunded',
          topic: ['reserve_refunded'],
          data: ['50000000000', '50000000000'],
        },
        {
          id: '9000000000000005',
          ledger: 100,
          ts: new Date('2026-08-01T00:00:00Z'),
          contractId: UNKNOWN_CONTRACT_ID,
          type: 'carry_updated',
          topic: ['carry_updated'],
          data: ['1', '900'],
        },
        // Classes 1 and 2 have the same label (MEZZANINE). Class 3 is the 4th tranche.
        ...[1, 2, 3].map((classIndex) => ({
          id: `900000000000001${classIndex}`,
          ledger: 100,
          ts: new Date('2026-08-01T00:00:00Z'),
          contractId: UNKNOWN_CONTRACT_ID,
          type: 'interest_paid',
          topic: ['interest_paid', classIndex],
          data: ['1', `${classIndex}000`, `${classIndex}000`, '0', '0'],
        })),
      ],
    });

    const response = await app.inject({ method: 'GET', url: `/api/deals/${deal!.id}/distributions` });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      distributions: {
        period: number;
        collections: string;
        reserveReleased: string;
        reserveRefunded: string;
        carryOut: string;
        perClass: { class: number; tranche: string | null; interest: string; principal: string }[];
        payments: Record<string, string>;
      }[] &
        RankEngineRow[];
      schedule: { periodNumber: number };
    }>();
    expect(body.distributions).toHaveLength(1);
    const row = body.distributions[0]!;
    expect(row.period).toBe(1);
    expect(row.collections).toBe('99000000000');
    expect(row.reserveReleased).toBe('50000000000');
    expect(row.reserveRefunded).toBe('50000000000');
    expect(row.carryOut).toBe('900');
    expect(row.perClass[0]).toMatchObject({
      class: 0,
      interest: '234083000',
      principal: '98151333000',
    });
    // Each class maps to its tranche through the class index, not the label.
    expect(row.perClass.map((entry) => [entry.class, entry.tranche])).toEqual([
      [0, TEST_CONTRACT_ID],
      [1, MEZZANINE_1_CONTRACT_ID],
      [2, MEZZANINE_2_CONTRACT_ID],
      [3, CLASS_3_CONTRACT_ID],
    ]);
    expect(row.payments[MEZZANINE_1_CONTRACT_ID]).toBe('1000');
    expect(row.payments[MEZZANINE_2_CONTRACT_ID]).toBe('2000');
    expect(row.payments[CLASS_3_CONTRACT_ID]).toBe('3000');
    expect(body.schedule.periodNumber).toBe(2);
    // A deal of the earlier code has no rank line and no settlement.
    expect(row.ranks).toEqual([]);
    expect(row.settlement).toBeNull();
    expect(row.triggers).toEqual([]);
    expect(row.parked).toEqual([]);

    await prisma.stellarEvent.deleteMany({ where: { contractId: UNKNOWN_CONTRACT_ID } });
  });

  it('adds the rank lines, the settlement, the triggers and the parked payouts of a period', async () => {
    // The events of deal P of the contract vectors: pro rata principal in
    // periods 1 and 2, then the trigger `seq` and sequential principal in
    // period 3. Two fee lines.
    const vector = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../contracts/abs-deal/vectors/deal-p.json', import.meta.url)),
        'utf8',
      ),
    ) as { periods: VectorPeriod[] };
    const periods = vector.periods.slice(0, 3);
    const deal = await prisma.deal.findFirst({ where: { name: TEST_DEAL_NAME } });
    expect(deal?.dealContractId).toBe(UNKNOWN_CONTRACT_ID);
    const SELLER = 'G' + 'S'.repeat(55);
    const FEES_RECIPIENT = 'G' + 'F'.repeat(55);
    // Fixed-width ids: their text order is the event order.
    const eventId = (period: number, index: number): string =>
      `vitest-rank-${String(period).padStart(2, '0')}-${String(index).padStart(4, '0')}`;
    const rows = periods.flatMap((period) =>
      period.events.map((event, index) => ({
        id: eventId(period.period, index),
        ledger: 200 + period.period,
        ts: new Date(`2026-11-${String(period.period).padStart(2, '0')}T00:00:00Z`),
        contractId: UNKNOWN_CONTRACT_ID,
        type: String(event.topics[0]),
        topic: event.topics as (string | number)[],
        data: event.data as (string | number | boolean | (string | number | (string | number)[])[][])[],
      })),
    );
    // Hand-made events after the events of period 3: a parked fee, a parked
    // residual and a second trigger.
    const extra = [
      { type: 'payout_parked', topic: ['payout_parked', FEES_RECIPIENT], data: [3, 1, '10'] },
      { type: 'payout_parked', topic: ['payout_parked', SELLER], data: [3, 7, '20'] },
      { type: 'trigger_breached', topic: ['trigger_breached', 'late'], data: [3] },
    ].map((event, index) => ({
      ...event,
      id: eventId(3, 9000 + index),
      ledger: 203,
      ts: new Date('2026-11-03T00:00:00Z'),
      contractId: UNKNOWN_CONTRACT_ID,
    }));
    await prisma.stellarEvent.createMany({ data: [...rows, ...extra] });

    const response = await app.inject({ method: 'GET', url: `/api/deals/${deal!.id}/distributions` });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      distributions: ({
        period: number;
        collections: string;
        fees: string;
        perClass: { class: number; tranche: string | null; interest: string; principal: string }[];
      } & RankEngineRow)[];
    }>();
    expect(body.distributions.map((row) => row.period)).toEqual([3, 2, 1]);

    const ITEM: Record<string, string> = {
      Fee: 'fee',
      Interest: 'interest',
      Principal: 'principal',
      ReserveRefill: 'reserveRefill',
      Residual: 'residual',
    };
    for (const period of periods) {
      const row = body.distributions.find((candidate) => candidate.period === period.period)!;
      // The lines of the period, in the order of execution.
      expect(row.ranks).toEqual(
        period.lines.map(([rank, [name, index], due, paid, dust]) => ({
          rank,
          item: ITEM[name],
          class: name === 'Interest' || name === 'Principal' ? index : null,
          feeIndex: name === 'Fee' ? index : null,
          due,
          paid,
          dust,
        })),
      );
      expect(row.settlement).toEqual({
        collections: period.settled.collections,
        reserveIn: period.settled.reserve_in,
        carryIn: period.settled.carry_in,
        drawn: period.settled.drawn,
        paidOut: period.settled.paid_out,
        reserve: period.settled.reserve,
        carry: period.settled.carry,
        owed: period.settled.owed,
        balance: period.settled.balance,
        surplus: period.settled.surplus,
        conserved: true,
        covered: true,
      });
      // The fields of before the rank engine keep their meaning. `fees` is
      // the sum of the two fee lines of the deal.
      expect(row.collections).toBe(period.collections);
      const feeEvents = period.events.filter((event) => event.topics[0] === 'fees_paid');
      expect(feeEvents).toHaveLength(2);
      expect(row.fees).toBe(feeEvents.reduce((sum, event) => sum + BigInt(String(event.data[0])), 0n).toString());
      expect(row.perClass.map((entry) => entry.class)).toEqual([0, 1, 2]);
      expect(row.perClass[0]?.tranche).toBe(TEST_CONTRACT_ID);
    }

    const [third, second, first] = body.distributions;
    // Pro rata principal, then sequential principal after the trigger.
    const principalRanks = (row: RankEngineRow): string[] => [
      ...new Set(row.ranks.filter((line) => line.item === 'principal').map((line) => line.rank)),
    ];
    expect(principalRanks(first!)).toEqual(['prin_pr']);
    expect(principalRanks(second!)).toEqual(['prin_pr']);
    expect(principalRanks(third!)).toEqual(['prin_seq']);
    expect(first!.triggers).toEqual([]);
    expect(second!.triggers).toEqual([]);
    // Several events of one period keep their order.
    expect(third!.triggers).toEqual([{ id: 'seq' }, { id: 'late' }]);
    expect(third!.parked).toEqual([
      { recipient: FEES_RECIPIENT, rank: 1, amount: '10' },
      { recipient: SELLER, rank: 7, amount: '20' },
    ]);
    expect(first!.parked).toEqual([]);

    await prisma.stellarEvent.deleteMany({ where: { contractId: UNKNOWN_CONTRACT_ID } });
  });

  it('keeps a period row when a settlement event does not have its shape', async () => {
    const deal = await prisma.deal.findFirst({ where: { name: TEST_DEAL_NAME } });
    const at = { ledger: 300, ts: new Date('2026-11-10T00:00:00Z'), contractId: UNKNOWN_CONTRACT_ID };
    await prisma.stellarEvent.createMany({
      data: [
        { ...at, id: 'vitest-odd-0001', type: 'distribution', topic: ['distribution', 9], data: ['5', '0', '0', '5'] },
        { ...at, id: 'vitest-odd-0002', type: 'rank_lines', topic: ['rank_lines', 9], data: [false, 'not-a-list'] },
        { ...at, id: 'vitest-odd-0003', type: 'period_settled', topic: ['period_settled', 9], data: ['1', '2'] },
      ],
    });
    const response = await app.inject({ method: 'GET', url: `/api/deals/${deal!.id}/distributions` });
    expect(response.statusCode).toBe(200);
    const row = response.json<{ distributions: ({ period: number; collections: string } & RankEngineRow)[] }>()
      .distributions[0]!;
    expect(row).toMatchObject({ period: 9, collections: '5', ranks: [], settlement: null });
    await prisma.stellarEvent.deleteMany({ where: { contractId: UNKNOWN_CONTRACT_ID } });
  });
});

describe('routes indexeur', () => {
  it('answers 404 on the stats of a note the registry does not know', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/notes/${'C' + 'D'.repeat(55)}/stats`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers an empty list for a history with no data', async () => {
    const response = await app.inject({ method: 'GET', url: `/notes/${TEST_CONTRACT_ID}/history` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('exposes an empty holder registry before the closing', async () => {
    const response = await app.inject({ method: 'GET', url: `/notes/${TEST_CONTRACT_ID}/holders` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});
