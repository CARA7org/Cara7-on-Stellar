import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  decodeDealConfig,
  encodeDealConfig,
  referenceOrders,
  type OnChainDealConfig,
  type OnChainItem,
} from '../src/deals/onchain.js';
import {
  initialState,
  payoffCollections,
  runPeriod,
  type EngineLine,
  type EngineState,
} from '../src/waterfall/engine.js';
import { loadVector, loadVectors, type VectorLedgers, type VectorPeriod } from './support/vectors.js';

/** The configuration of a vector, read as `get_config` gives it. */
function configOf(configXdr: string): OnChainDealConfig {
  return decodeDealConfig(scValToNative(xdr.ScVal.fromXDR(configXdr, 'hex')));
}

function stateOf(ledgers: VectorLedgers): EngineState {
  return {
    phase: ledgers.state,
    reserve: ledgers.reserve,
    carry: ledgers.carry,
    owed: ledgers.owed,
    balance: ledgers.balance,
    perNote: ledgers.per_note,
    shortfall: ledgers.shortfall,
    triggers: ledgers.triggers,
  };
}

function itemOf(item: VectorPeriod['lines'][number][1]): OnChainItem {
  switch (item[0]) {
    case 'Fee':
      return { kind: 'fee', index: item[1] };
    case 'Interest':
      return { kind: 'interest', class: item[1] };
    case 'Principal':
      return { kind: 'principal', class: item[1] };
    case 'ReserveRefill':
      return { kind: 'reserveRefill' };
    case 'Residual':
      return { kind: 'residual' };
  }
}

function linesOf(period: VectorPeriod): EngineLine[] {
  return period.lines.map(([rank, item, due, paid, dust]) => ({ rank, item: itemOf(item), due, paid, dust }));
}

const vectors = loadVectors();

describe('the codec of the deal configuration', () => {
  it('finds the vectors of the contract tests', () => {
    expect(vectors.map((vector) => vector.name)).toEqual(
      expect.arrayContaining(['reference', 'deal-s', 'deal-p', 'largest-structure']),
    );
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    'encodes the configuration of "%s" to the bytes of the contract',
    (_name, vector) => {
      const config = configOf(vector.config_xdr);
      expect(encodeDealConfig(config).toXDR('hex')).toBe(vector.config_xdr);
    },
  );

  it('reads the reference order of the contract tests', () => {
    const config = configOf(loadVector('reference').config_xdr);
    expect({ normal: config.normal, enforced: config.enforced }).toEqual(referenceOrders(3));
    expect(config.classes).toEqual([
      { rate: { kind: 'floating', units: 600n }, totalNotes: 1000n, floor: 0n, indexFloor: null },
      { rate: { kind: 'fixed', units: 1000n }, totalNotes: 700n, floor: null, indexFloor: null },
      { rate: { kind: 'fixed', units: 1500n }, totalNotes: 450n, floor: null, indexFloor: null },
    ]);
    expect(config.fees).toHaveLength(1);
    expect(config.fees[0]?.amount).toEqual({ kind: 'fixed', amount: 50n });
    expect(config.reserve).toEqual({ required: { kind: 'fixed', amount: 5000n }, release: 'full', drawRanks: [] });
    expect(config).toMatchObject({ daysInPeriod: 30, noteDenomination: 1000n, roundUnit: 1n });
  });

  it('reads the structure of deal P', () => {
    const config = configOf(loadVector('deal-p').config_xdr);
    expect(config.reserve).toEqual({
      required: { kind: 'pctOfNotes', pct: 5000n, floor: 200_000_000n },
      release: 'onNeed',
      drawRanks: ['fees', 'int_a', 'int_b'],
    });
    expect(config.triggers).toEqual([
      { id: 'seq', metric: { kind: 'notesFactor' }, op: 'lt', threshold: 5_000_000n, latch: true },
    ]);
    expect(config.fees.map((line) => line.amount)).toEqual([
      { kind: 'fixed', amount: 10_000_000n },
      { kind: 'perAnnum', rate: 1000n },
    ]);
    expect(config.classes[0]).toEqual({
      rate: { kind: 'floating', units: 700n },
      totalNotes: 6n,
      floor: null,
      indexFloor: 0n,
    });
    expect(config.normal.map((entry) => [entry.id, entry.when.kind, entry.alloc])).toEqual([
      ['fees', 'always', 'sequential'],
      ['int_a', 'always', 'sequential'],
      ['int_b', 'always', 'sequential'],
      ['reserve', 'always', 'sequential'],
      ['int_c', 'always', 'sequential'],
      ['prin_pr', 'notTrigger', 'pariPassu'],
      ['prin_seq', 'trigger', 'sequential'],
      ['residual', 'always', 'sequential'],
    ]);
  });

  it('gives the reference order to a deal of the earlier contract code', () => {
    const current = configOf(loadVector('reference').config_xdr);
    // The value that `get_config` of the earlier code returns.
    const earlier = {
      admin: current.admin,
      asset: current.asset,
      oracle: current.oracle,
      seller: current.seller,
      servicer: current.servicer,
      fees_recipient: current.fees[0]?.recipient,
      fees_per_period: 50n,
      required_reserve: 5000n,
      days_in_period: 30,
      oracle_max_staleness_secs: 604_800n,
      note_denomination: 1000n,
      round_unit: 1n,
      classes: [
        { rate: ['Floating', 600n], total_notes: 1000n },
        { rate: ['Fixed', 1000n], total_notes: 700n },
        { rate: ['Fixed', 1500n], total_notes: 450n },
      ],
    };
    expect(decodeDealConfig(earlier)).toEqual(current);
  });
});

describe('the copy of the rank engine', () => {
  const cases = vectors.flatMap((vector) =>
    vector.periods.map((period) => [`${vector.name}, period ${period.period}`, vector, period] as const),
  );

  it.each(cases)('gives the figures of the contract: %s', (_label, vector, period) => {
    const config = configOf(vector.config_xdr);
    const result = runPeriod(config, stateOf(period.opening), {
      collections: period.collections,
      fixing: period.fixing,
      parked: period.parked,
    });
    expect(result.lines).toEqual(linesOf(period));
    expect(result.enforced).toBe(period.enforced);
    expect(result.settled).toEqual({
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
    });
    expect(result.breached).toEqual(period.breached);
    expect(result.payments.map((payment) => payment.interest + payment.principal)).toEqual(period.returned);
    expect(result.closing).toEqual(stateOf(period.closing));
  });

  it('follows a deal from its closing to its maturity', () => {
    for (const vector of vectors) {
      // A vector with a step outside the engine (enforcement, a surplus, a
      // new fixing) is not a plain sequence of payment dates.
      if (!['deal-s', 'deal-p', 'percent-reserve-on-need', 'two-fee-lines'].includes(vector.name)) continue;
      const config = configOf(vector.config_xdr);
      let state = initialState(config);
      for (const period of vector.periods) {
        expect(state, `${vector.name}, opening of period ${period.period}`).toEqual(stateOf(period.opening));
        state = runPeriod(config, state, { collections: period.collections, fixing: period.fixing }).closing;
      }
      expect(state, vector.name).toEqual(stateOf(vector.periods.at(-1)?.closing as VectorLedgers));
    }
  });

  it('refuses a payment date of a matured deal and a floating deal with no fixing', () => {
    const vector = loadVector('deal-s');
    const config = configOf(vector.config_xdr);
    const matured = stateOf(vector.periods.at(-1)?.closing as VectorLedgers);
    expect(matured.phase).toBe('Matured');
    expect(() => runPeriod(config, matured, { collections: 1n, fixing: 2209n })).toThrow(/matured/);
    expect(() => runPeriod(config, initialState(config), { collections: 1n, fixing: null })).toThrow(/fixing/);
  });
});

describe('the payoff amount', () => {
  it('is the smallest collections that bring deal S to its maturity', () => {
    const vector = loadVector('deal-s');
    const config = configOf(vector.config_xdr);
    const second = vector.periods[1] as VectorPeriod;
    const state = stateOf(second.opening);
    const payoff = payoffCollections(config, state, second.fixing);
    expect(runPeriod(config, state, { collections: payoff, fixing: second.fixing }).matured).toBe(true);
    expect(runPeriod(config, state, { collections: payoff - 1n, fixing: second.fixing }).matured).toBe(false);
    // The vector pays 70 and the Seller takes a residual of 3.8323313: the
    // payoff is 70 minus this residual.
    expect(payoff).toBe(700_000_000n - 38_323_313n);
  });

  it('exists for every structure of the vectors', () => {
    for (const vector of vectors) {
      const config = configOf(vector.config_xdr);
      const first = vector.periods[0] as VectorPeriod;
      if (first.opening.state !== 'Amortizing') continue;
      const state = stateOf(first.opening);
      const payoff = payoffCollections(config, state, first.fixing);
      expect(runPeriod(config, state, { collections: payoff, fixing: first.fixing }).matured, vector.name).toBe(true);
    }
  });
});
