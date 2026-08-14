import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';

const TEST_DEAL_NAME = 'Deal de test vitest cara7';
const TEST_CONTRACT_ID = 'C' + 'A'.repeat(55);
const UNKNOWN_CONTRACT_ID = 'C' + 'B'.repeat(55);

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await prisma.deal.deleteMany({ where: { name: TEST_DEAL_NAME } });
});

afterAll(async () => {
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

    const list = await app.inject({ method: 'GET', url: '/api/tranches' });
    expect(list.statusCode).toBe(200);
    const { tranches } = list.json<{
      tranches: { contractId: string; originalFace: string; stats: { phase: string } | null }[];
    }>();
    const testTranche = tranches.find((tranche) => tranche.contractId === TEST_CONTRACT_ID);
    expect(testTranche).toBeDefined();
    expect(testTranche?.originalFace).toBe('450000000000');
    // No snapshot: nominal funding state, and no NAV anywhere.
    expect(testTranche?.stats?.phase).toBe('FUNDING');
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
        perClass: { class: number; interest: string; principal: string }[];
      }[];
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
    expect(body.schedule.periodNumber).toBe(2);

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
