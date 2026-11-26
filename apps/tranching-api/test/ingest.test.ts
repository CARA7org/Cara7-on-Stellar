import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { prisma } from '../src/db.js';
import { resolveTranche, storeEvent } from '../src/ingest.js';
import { KNOWN_EVENT_TYPES, readPeriodSettled, type DecodedEvent } from '../src/decode.js';

// Test rows only: a 4-class test deal with fake contract ids. The cleanup
// removes these rows and no other row.
const TEST_DEAL_NAME = 'Deal de test vitest cara7 ingest';
const DEAL_CONTRACT_ID = 'C' + 'J'.repeat(55);
const AGENT_CONTRACT_ID = 'C' + 'K'.repeat(55);
const NOTE_CONTRACT_IDS = ['L', 'M', 'N', 'O'].map((letter) => 'C' + letter.repeat(55));
const INVESTOR = 'G' + 'T'.repeat(55);
// Two classes of this deal have the same label.
const LABELS = ['SENIOR', 'MEZZANINE', 'MEZZANINE', 'JUNIOR'];
// A topic that no contract of a deal publishes.
const UNKNOWN_TOPIC = 'topic_of_another_contract';

async function removeTestRows(): Promise<void> {
  await prisma.stellarEvent.deleteMany({
    where: { contractId: { in: [DEAL_CONTRACT_ID, AGENT_CONTRACT_ID] } },
  });
  await prisma.userPosition.deleteMany({ where: { tranche: { in: NOTE_CONTRACT_IDS } } });
  await prisma.deal.deleteMany({ where: { name: TEST_DEAL_NAME } });
}

function eventOf(
  id: string,
  contractId: string,
  type: string,
  topics: unknown[],
  data: unknown,
): DecodedEvent {
  return {
    id,
    ledger: 1,
    ts: new Date('2026-11-17T00:00:00Z'),
    contractId,
    type,
    topics: [type, ...topics],
    data,
  };
}

beforeAll(async () => {
  await removeTestRows();
  await prisma.deal.create({
    data: {
      name: TEST_DEAL_NAME,
      dealContractId: DEAL_CONTRACT_ID,
      payingAgentContractId: AGENT_CONTRACT_ID,
      tranches: {
        create: NOTE_CONTRACT_IDS.map((contractId, classIndex) => ({
          name: `Class ${'ABCD'[classIndex]} Notes`,
          classIndex,
          seniority: LABELS[classIndex]!,
          contractId,
          baseAssetId: DEAL_CONTRACT_ID,
          originalFace: new Prisma.Decimal('100000000000'),
          assetSymbol: 'EURC',
          assetDecimals: 7,
        })),
      },
    },
  });
});

afterAll(async () => {
  await removeTestRows();
});

describe('ingest by class index', () => {
  it('maps an event of class 3 to the 4th tranche', async () => {
    // abs-deal: topics [subscribed, investor], data [class, notes, amount]
    const event = eventOf('vitest-ingest-1', DEAL_CONTRACT_ID, 'subscribed', [INVESTOR], [
      '3',
      '10',
      '1000000000',
    ]);
    expect(await storeEvent(event)).toBe(true);
    const position = await prisma.userPosition.findUnique({
      where: { tranche_address: { tranche: NOTE_CONTRACT_IDS[3]!, address: INVESTOR } },
    });
    expect(position?.subscribed.toString()).toBe('1000000000');
    expect(await resolveTranche({ deal: DEAL_CONTRACT_ID }, 3)).toBe(NOTE_CONTRACT_IDS[3]);
    expect(await resolveTranche({ agent: AGENT_CONTRACT_ID }, 3)).toBe(NOTE_CONTRACT_IDS[3]);
  });

  it('keeps apart two tranches with the same seniority label', async () => {
    // paying-agent: topics [holder_paid, holder], data [period, class, interest, principal]
    for (const [id, classIndex, interest] of [
      ['vitest-ingest-2', '1', '111'],
      ['vitest-ingest-3', '2', '222'],
    ]) {
      const event = eventOf(id!, AGENT_CONTRACT_ID, 'holder_paid', [INVESTOR], [
        '1',
        classIndex,
        interest,
        '0',
      ]);
      expect(await storeEvent(event)).toBe(true);
    }
    const positions = await prisma.userPosition.findMany({
      where: { address: INVESTOR, tranche: { in: [NOTE_CONTRACT_IDS[1]!, NOTE_CONTRACT_IDS[2]!] } },
      orderBy: { tranche: 'asc' },
    });
    expect(positions.map((row) => [row.tranche, row.interestReceived.toString()])).toEqual([
      [NOTE_CONTRACT_IDS[1], '111'],
      [NOTE_CONTRACT_IDS[2], '222'],
    ]);
  });

  it('finds no tranche for a class that the deal does not have', async () => {
    expect(await resolveTranche({ deal: DEAL_CONTRACT_ID }, 4)).toBeNull();
    expect(await resolveTranche({ deal: DEAL_CONTRACT_ID }, Number.NaN)).toBeNull();
  });
});

describe('unknown event topics', () => {
  it('stores an unknown topic raw, also with a void body', async () => {
    const event = eventOf('vitest-ingest-4', DEAL_CONTRACT_ID, UNKNOWN_TOPIC, [INVESTOR], null);
    expect(await storeEvent(event)).toBe(true);
    const row = await prisma.stellarEvent.findUnique({ where: { id: 'vitest-ingest-4' } });
    expect(row).toMatchObject({
      type: UNKNOWN_TOPIC,
      topic: [UNKNOWN_TOPIC, INVESTOR],
      data: null,
    });
    // The second ingestion of the same event is a duplicate, not an error.
    expect(await storeEvent(event)).toBe(false);
  });

  it('skips an unknown topic that it cannot store, and goes on', async () => {
    const errors: string[] = [];
    const log = { info: () => undefined, error: (message: string) => void errors.push(message) };
    // PostgreSQL refuses a NUL character in a jsonb value.
    const event = eventOf('vitest-ingest-5', DEAL_CONTRACT_ID, UNKNOWN_TOPIC, ['bad\u0000topic'], [
      '0',
      '1',
      '0',
    ]);
    expect(await storeEvent(event, log)).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`unknown event ${UNKNOWN_TOPIC} vitest-ingest-5 skipped`);
    expect(await prisma.stellarEvent.findUnique({ where: { id: 'vitest-ingest-5' } })).toBeNull();
  });

  it('still stops on a known topic that it cannot store', async () => {
    const event = eventOf('vitest-ingest-6', DEAL_CONTRACT_ID, 'subscribed', ['bad\u0000topic'], [
      '0',
      '1',
      '100',
    ]);
    await expect(storeEvent(event)).rejects.toThrow();
  });
});

describe('events of a payment date of the rank engine', () => {
  it('knows the six event types', async () => {
    // A known topic that the indexer cannot store stops the cycle: the next
    // cycle tries it again, so no settlement event is lost.
    const types = [
      'rank_lines',
      'period_settled',
      'trigger_breached',
      'payout_parked',
      'owed_claimed',
      'eligibility_set',
    ];
    for (const [index, type] of types.entries()) {
      expect(KNOWN_EVENT_TYPES.has(type)).toBe(true);
      const event = eventOf(`vitest-ingest-1${index}`, DEAL_CONTRACT_ID, type, ['bad\u0000topic'], []);
      await expect(storeEvent(event)).rejects.toThrow();
    }
    expect(KNOWN_EVENT_TYPES.has(UNKNOWN_TOPIC)).toBe(false);
  });

  it('stores an event in the form that its reader takes', async () => {
    // abs-deal: topics [period_settled, period], data: 10 amounts.
    const amounts = ['100000', '5000', '0', '0', '98500', '5000', '1500', '0', '6500', '0'];
    const event = eventOf('vitest-ingest-7', DEAL_CONTRACT_ID, 'period_settled', [1], amounts.map(BigInt));
    expect(await storeEvent(event)).toBe(true);
    const row = await prisma.stellarEvent.findUnique({ where: { id: 'vitest-ingest-7' } });
    expect(row?.data).toEqual(amounts);
    expect(readPeriodSettled(row?.topic, row?.data)).toMatchObject({ period: 1, paidOut: '98500', balance: '6500' });
  });
});
