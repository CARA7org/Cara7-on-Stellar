import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import { jsonSafe } from '../src/db.js';
import {
  decodeEvent,
  readEligibilitySet,
  readOwedClaimed,
  readPayoutParked,
  readPeriodSettled,
  readRankLines,
  readTriggerBreached,
  settlementChecks,
  type PeriodSettlement,
  type RankItemKind,
  type RankLine,
} from '../src/decode.js';

/**
 * The vectors of the abs-deal contract: real events of real payment dates,
 * written by the Rust tests (contracts/abs-deal/src/test_vectors.rs). Each
 * event has its XDR and a readable copy. Each period has the expected rank
 * lines and settlement.
 */
const VECTOR_DIR = fileURLToPath(new URL('../../../contracts/abs-deal/vectors/', import.meta.url));

interface VectorEvent {
  topics: unknown[];
  data: unknown;
  /// Hex of the XDR of the ContractEvent.
  xdr: string;
}

/// [rank id, [item name, index?], due, paid, dust]
type VectorLine = [string, [string, number?], string, string, string];

interface VectorPeriod {
  period: number;
  enforced: boolean;
  lines: VectorLine[];
  settled: Record<string, string>;
  breached: string[];
  parked: string[];
  events: VectorEvent[];
}

interface Vector {
  name: string;
  contracts: { deal: string };
  periods: VectorPeriod[];
}

const vectors: Vector[] = readdirSync(VECTOR_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => JSON.parse(readFileSync(path.join(VECTOR_DIR, file), 'utf8')) as Vector);

/// What the indexer gets from the RPC for one event of a vector, then what it
/// stores: the topics and the data after `decodeEvent` and `jsonSafe`.
function ingested(event: VectorEvent, contractId: string): {
  type: string;
  decoded: { topics: unknown; data: unknown };
  stored: { topics: unknown; data: unknown };
} {
  const body = xdr.ContractEvent.fromXDR(event.xdr, 'hex').body().v0();
  const decoded = decodeEvent({
    id: '0000000001-0000000001',
    ledger: 1,
    ledgerClosedAt: '2026-11-23T00:00:00Z',
    contractId,
    topic: body.topics(),
    value: body.data(),
  });
  return {
    type: decoded.type,
    decoded: { topics: decoded.topics, data: decoded.data },
    stored: { topics: jsonSafe(decoded.topics), data: jsonSafe(decoded.data) },
  };
}

const ITEM_KIND: Record<string, RankItemKind> = {
  Fee: 'fee',
  Interest: 'interest',
  Principal: 'principal',
  ReserveRefill: 'reserveRefill',
  Residual: 'residual',
};

function expectedLine([rank, [name, index], due, paid, dust]: VectorLine): RankLine {
  return { rank, item: { kind: ITEM_KIND[name]!, index: index ?? null }, due, paid, dust };
}

function expectedSettlement(period: VectorPeriod): PeriodSettlement {
  const settled = period.settled;
  return {
    period: period.period,
    collections: settled.collections!,
    reserveIn: settled.reserve_in!,
    carryIn: settled.carry_in!,
    drawn: settled.drawn!,
    paidOut: settled.paid_out!,
    reserve: settled.reserve!,
    carry: settled.carry!,
    owed: settled.owed!,
    balance: settled.balance!,
    surplus: settled.surplus!,
  };
}

describe('the events of the contract vectors', () => {
  it('finds the vector files', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(10);
    expect(vectors.map((vector) => vector.name)).toContain('deal-p');
  });

  it('stores each event in the readable form of the vectors', () => {
    let events = 0;
    for (const vector of vectors) {
      for (const period of vector.periods) {
        for (const event of period.events) {
          const { type, stored } = ingested(event, vector.contracts.deal);
          expect(type, `${vector.name} period ${period.period}`).toBe(event.topics[0]);
          expect(stored.topics, `${vector.name} period ${period.period} ${type}`).toEqual(event.topics);
          expect(stored.data, `${vector.name} period ${period.period} ${type}`).toEqual(event.data);
          events += 1;
        }
      }
    }
    expect(events).toBeGreaterThan(500);
  });

  it('reads the rank lines of each payment date', () => {
    let read = 0;
    for (const vector of vectors) {
      for (const period of vector.periods) {
        const where = `${vector.name} period ${period.period}`;
        const found = period.events
          .map((event) => ingested(event, vector.contracts.deal))
          .filter((event) => event.type === 'rank_lines');
        expect(found, where).toHaveLength(1);
        const expected = {
          period: period.period,
          enforced: period.enforced,
          lines: period.lines.map(expectedLine),
        };
        // The stored form, and the form that comes straight from the SDK.
        expect(readRankLines(found[0]!.stored.topics, found[0]!.stored.data), where).toEqual(expected);
        expect(readRankLines(found[0]!.decoded.topics, found[0]!.decoded.data), where).toEqual(expected);
        read += 1;
      }
    }
    expect(read).toBeGreaterThanOrEqual(30);
  });

  it('reads the settlement of each payment date, and both rules hold', () => {
    let read = 0;
    for (const vector of vectors) {
      for (const period of vector.periods) {
        const where = `${vector.name} period ${period.period}`;
        const found = period.events
          .map((event) => ingested(event, vector.contracts.deal))
          .filter((event) => event.type === 'period_settled');
        expect(found, where).toHaveLength(1);
        const settlement = readPeriodSettled(found[0]!.stored.topics, found[0]!.stored.data);
        expect(settlement, where).toEqual(expectedSettlement(period));
        expect(readPeriodSettled(found[0]!.decoded.topics, found[0]!.decoded.data), where).toEqual(settlement);
        // The contract checks conservation and the balance invariant itself.
        expect(settlementChecks(settlement!), where).toEqual({ conserved: true, covered: true });
        read += 1;
      }
    }
    expect(read).toBeGreaterThanOrEqual(30);
  });

  it('reads the triggers and the parked payouts of each payment date', () => {
    let triggers = 0;
    let parked = 0;
    for (const vector of vectors) {
      for (const period of vector.periods) {
        const where = `${vector.name} period ${period.period}`;
        const events = period.events.map((event) => ingested(event, vector.contracts.deal));
        const breached = events
          .filter((event) => event.type === 'trigger_breached')
          .map((event) => readTriggerBreached(event.stored.topics, event.stored.data));
        expect(breached, where).toEqual(period.breached.map((id) => ({ id, period: period.period })));
        triggers += breached.length;

        const payouts = events
          .filter((event) => event.type === 'payout_parked')
          .map((event) => readPayoutParked(event.stored.topics, event.stored.data));
        expect(payouts.map((payout) => payout?.recipient), where).toEqual(period.parked);
        for (const payout of payouts) {
          expect(payout?.period, where).toBe(period.period);
          // Payout codes of the contract: 1 for a fee line, 7 for the residual.
          expect([1, 7], where).toContain(payout?.rank);
          expect(BigInt(payout!.amount) > 0n, where).toBe(true);
        }
        parked += payouts.length;
      }
    }
    expect(triggers).toBeGreaterThan(0);
    expect(parked).toBeGreaterThan(0);
  });

  it('names the two ranks of deal P: pro rata, then sequential', () => {
    const dealP = vectors.find((vector) => vector.name === 'deal-p')!;
    const principalRanks = dealP.periods.map((period) => {
      const event = period.events
        .map((candidate) => ingested(candidate, dealP.contracts.deal))
        .find((candidate) => candidate.type === 'rank_lines')!;
      const lines = readRankLines(event.stored.topics, event.stored.data)!.lines;
      return [...new Set(lines.filter((line) => line.item.kind === 'principal').map((line) => line.rank))];
    });
    expect(principalRanks).toEqual([['prin_pr'], ['prin_pr'], ['prin_seq'], ['prin_seq']]);
  });
});

describe('readers on hand-made events', () => {
  const HOLDER = 'G' + 'A'.repeat(55);

  it('reads owed_claimed and eligibility_set', () => {
    // abs-deal: topics [owed_claimed, recipient], data [amount]
    expect(readOwedClaimed(['owed_claimed', HOLDER], ['300000000'])).toEqual({
      recipient: HOLDER,
      amount: '300000000',
    });
    expect(readOwedClaimed(['owed_claimed', HOLDER], [300000000n])?.amount).toBe('300000000');
    // abs-deal: topics [eligibility_set, holder], data [eligible]
    expect(readEligibilitySet(['eligibility_set', HOLDER], [true])).toEqual({ holder: HOLDER, eligible: true });
    expect(readEligibilitySet(['eligibility_set', HOLDER], [false])?.eligible).toBe(false);
  });

  it('reads a parked payout and a trigger', () => {
    expect(readPayoutParked(['payout_parked', HOLDER], [3, 7, '61580000000'])).toEqual({
      recipient: HOLDER,
      period: 3,
      rank: 7,
      amount: '61580000000',
    });
    expect(readTriggerBreached(['trigger_breached', 'seq'], [3])).toEqual({ id: 'seq', period: 3 });
  });

  it('gives each item its kind and its index', () => {
    const lines = readRankLines(['rank_lines', 2], [
      true,
      [
        ['fees', ['Fee', 1], '30', '30', '0'],
        ['acc_a', ['Interest', 0], '2340', '2000', '340'],
        ['acc_a', ['Principal', 0], '1000000', '7000', '610'],
        ['reserve', ['ReserveRefill'], '5000', '0', '0'],
        ['residual', ['Residual'], '12', '12', '0'],
      ],
    ]);
    expect(lines?.enforced).toBe(true);
    expect(lines?.lines.map((line) => [line.rank, line.item.kind, line.item.index])).toEqual([
      ['fees', 'fee', 1],
      ['acc_a', 'interest', 0],
      ['acc_a', 'principal', 0],
      ['reserve', 'reserveRefill', null],
      ['residual', 'residual', null],
    ]);
    // A period with no line.
    expect(readRankLines(['rank_lines', 1], [false, []])).toEqual({ period: 1, enforced: false, lines: [] });
  });

  it('gives null for an event that does not have the shape of its type', () => {
    const line = ['fees', ['Fee', 0], '50', '50', '0'];
    const shapes: [unknown, unknown][] = [
      [['rank_lines'], [false, [line]]], // no period
      [['rank_lines', 1], null], // void body
      [['rank_lines', 1], ['false', [line]]], // enforced is not a boolean
      [['rank_lines', 1], [false, 'lines']], // lines is not a list
      [['rank_lines', 1], [false, [['fees', ['Swap', 0], '50', '50', '0']]]], // unknown item
      [['rank_lines', 1], [false, [['fees', ['constructor'], '50', '50', '0']]]], // a name of Object
      [['rank_lines', 1], [false, [['fees', ['Fee'], '50', '50', '0']]]], // a fee with no index
      [['rank_lines', 1], [false, [['fees', ['Residual', 0], '50', '50', '0']]]], // a residual with an index
      [['rank_lines', 1], [false, [['fees', ['Fee', 0], '50', 'x', '0']]]], // not an amount
      [['rank_lines', 1], [false, [['fees', ['Fee', 0], '50', '50']]]], // no dust
      [['rank_lines', 1], [false, [line, 'line']]], // one bad line refuses the event
    ];
    for (const [topics, data] of shapes) {
      expect(readRankLines(topics, data), JSON.stringify([topics, data])).toBeNull();
    }
    const nine = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    expect(readPeriodSettled(['period_settled', 1], nine)).toBeNull();
    expect(readPeriodSettled(['period_settled'], [...nine, '10'])).toBeNull();
    expect(readPeriodSettled(['period_settled', 1], [...nine, 1.5])).toBeNull();
    expect(readPeriodSettled('period_settled', { xdr: null })).toBeNull();
    expect(readTriggerBreached(['trigger_breached'], [1])).toBeNull();
    expect(readTriggerBreached(['trigger_breached', 'seq'], [])).toBeNull();
    expect(readPayoutParked(['payout_parked', HOLDER], [1, 1])).toBeNull();
    expect(readPayoutParked(['payout_parked'], [1, 1, '5'])).toBeNull();
    expect(readOwedClaimed(['owed_claimed', HOLDER], [])).toBeNull();
    expect(readEligibilitySet(['eligibility_set', HOLDER], ['true'])).toBeNull();
    expect(readEligibilitySet(['eligibility_set'], [true])).toBeNull();
  });

  it('checks conservation and the balance invariant of a settlement', () => {
    const settlement: PeriodSettlement = {
      period: 1,
      collections: '100000',
      reserveIn: '5000',
      carryIn: '0',
      drawn: '0',
      paidOut: '98500',
      reserve: '5000',
      carry: '1500',
      owed: '0',
      balance: '6500',
      surplus: '0',
    };
    expect(settlementChecks(settlement)).toEqual({ conserved: true, covered: true });
    // A surplus in the deal: the balance is above the ledgers.
    expect(settlementChecks({ ...settlement, balance: '6507' })).toEqual({ conserved: true, covered: true });
    // One unit is missing in the balance: a clawback.
    expect(settlementChecks({ ...settlement, balance: '6499' })).toEqual({ conserved: true, covered: false });
    // A parked payout is owed: the balance must cover it too.
    expect(settlementChecks({ ...settlement, owed: '50' })).toEqual({ conserved: true, covered: false });
    // One unit left the ledgers and is in no figure.
    expect(settlementChecks({ ...settlement, paidOut: '98499' })).toEqual({ conserved: false, covered: true });
  });
});
