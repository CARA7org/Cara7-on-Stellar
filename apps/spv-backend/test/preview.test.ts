import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { formatUnits } from '../src/deals/amounts.js';
import { enginePreview } from '../src/waterfall/routes.js';
import { TEST_EURC } from './support/fakes.js';
import { loadVector, type Vector, type VectorPeriod } from './support/vectors.js';

const DECIMALS = 7;
const units = (value: bigint): string => formatUnits(value, DECIMALS);

/** A reader that answers with the ledgers of a vector before one payment date. */
function readerOf(vector: Vector, period: VectorPeriod, missing: readonly string[] = []) {
  const opening = period.opening;
  const answers: Record<string, unknown> = {
    get_config: scValToNative(xdr.ScVal.fromXDR(vector.config_xdr, 'hex')),
    // `scValToNative` gives the state as a list with the variant name.
    get_state: [opening.state],
    get_reserve: opening.reserve,
    get_carry: opening.carry,
    get_owed_total: opening.owed,
    get_triggers: opening.triggers,
    get_class_states: opening.per_note.map((perNote, index) => ({
      per_note_outstanding: perNote,
      shortfall: opening.shortfall[index],
    })),
    balance: opening.balance,
    lastprice: period.fixing === null ? null : { price: period.fixing, timestamp: 0n },
    name: TEST_EURC.name,
    symbol: 'EURC',
    decimals: DECIMALS,
  };
  return async (_contractId: string, method: string): Promise<unknown> => {
    if (missing.includes(method) || !(method in answers)) throw new Error(`Simulation failed (${method})`);
    return answers[method];
  };
}

describe('the preview of the next payment date', () => {
  it('gives the rank lines and the settlement that the contract gives (deal P, period 1)', async () => {
    const vector = loadVector('deal-p');
    const period = vector.periods[0] as VectorPeriod;
    const view = await enginePreview(readerOf(vector, period), units(period.collections));
    expect(view?.phase).toBe('Amortizing');
    // 5 % of the 1,000 of notes.
    expect(view?.requiredReserve).toBe('50');
    expect(view?.triggers).toEqual([{ id: 'seq', set: false }]);
    const preview = view?.preview;
    expect(preview?.lines.map((line) => [line.rank, line.item, line.class, line.feeIndex, line.due, line.paid, line.dust])).toEqual(
      period.lines.map(([rank, item, due, paid, dust]) => [
        rank,
        { Fee: 'fee', Interest: 'interest', Principal: 'principal', ReserveRefill: 'reserveRefill', Residual: 'residual' }[item[0]],
        item[0] === 'Interest' || item[0] === 'Principal' ? item[1] : null,
        item[0] === 'Fee' ? item[1] : null,
        units(due),
        units(paid),
        units(dust),
      ]),
    );
    // Pro rata: the same principal for each note of the three classes.
    expect(preview?.closing.perNote).toEqual(['69.93', '69.93', '69.93']);
    expect(preview?.settled).toMatchObject({
      collections: '305',
      reserveIn: '50',
      paidOut: units(period.settled.paid_out),
      reserve: '50',
      carry: units(period.settled.carry),
    });
    expect(preview?.matures).toBe(false);
    expect(preview?.breached).toEqual([]);
  });

  it('names the trigger that the next payment date sets (deal P, period 3)', async () => {
    const vector = loadVector('deal-p');
    const period = vector.periods[2] as VectorPeriod;
    const view = await enginePreview(readerOf(vector, period), '105');
    expect(view?.preview?.breached).toEqual(['seq']);
    // Sequential now: principal to Class A only.
    expect(view?.preview?.lines.filter((line) => line.item === 'principal').map((line) => [line.rank, line.class, line.paid])).toEqual([
      ['prin_seq', 0, '117.84'],
      ['prin_seq', 1, '0'],
      ['prin_seq', 2, '0'],
    ]);
  });

  it('gives the payoff amount, with or without collections in the request', async () => {
    const vector = loadVector('deal-s');
    const second = vector.periods[1] as VectorPeriod;
    const view = await enginePreview(readerOf(vector, second));
    expect(view?.preview).toBeNull();
    expect(view?.payoffCollections).toBe('66.1676687');
    const paid = await enginePreview(readerOf(vector, second), '66.1676687');
    expect(paid?.preview?.matures).toBe(true);
    expect(paid?.preview?.closing.perNote).toEqual(['0', '0', '0', '0']);
  });

  it('reads a deal of the earlier contract code, which has no trigger and no owed getter', async () => {
    const vector = loadVector('reference');
    const period = vector.periods[0] as VectorPeriod;
    const config = scValToNative(xdr.ScVal.fromXDR(vector.config_xdr, 'hex')) as Record<string, unknown> & {
      fees: { recipient: string }[];
      classes: { rate: unknown; total_notes: bigint }[];
    };
    const earlier = {
      admin: config.admin,
      asset: config.asset,
      oracle: config.oracle,
      seller: config.seller,
      servicer: config.servicer,
      fees_recipient: config.fees[0]?.recipient,
      fees_per_period: 50n,
      required_reserve: 5000n,
      days_in_period: 30,
      oracle_max_staleness_secs: 604_800n,
      note_denomination: 1000n,
      round_unit: 1n,
      classes: config.classes.map((terms) => ({ rate: terms.rate, total_notes: terms.total_notes })),
    };
    const base = readerOf(vector, period, ['get_owed_total', 'get_triggers']);
    const read = async (contractId: string, method: string): Promise<unknown> =>
      method === 'get_config' ? earlier : base(contractId, method);
    const view = await enginePreview(read, units(period.collections));
    // The earlier code pays in the reference order: the same lines.
    expect(view?.preview?.lines.map((line) => line.paid)).toEqual(period.lines.map((line) => units(line[3])));
    expect(view?.preview?.settled.carry).toBe(units(period.settled.carry));
  });

  it('gives no preview before the closing and after the maturity', async () => {
    const vector = loadVector('deal-s');
    const first = vector.periods[0] as VectorPeriod;
    const funding = readerOf(vector, first);
    const beforeClosing = async (contractId: string, method: string): Promise<unknown> =>
      method === 'get_state' ? ['Funding'] : funding(contractId, method);
    expect(await enginePreview(beforeClosing, '35')).toBeNull();

    const last = vector.periods.at(-1) as VectorPeriod;
    const matured = readerOf(vector, { ...last, opening: last.closing });
    const view = await enginePreview(matured, '35');
    expect(view).toMatchObject({ phase: 'Matured', payoffCollections: null, preview: null });
  });

  it('refuses collections with more decimals than the asset has', async () => {
    const vector = loadVector('deal-s');
    const first = vector.periods[0] as VectorPeriod;
    await expect(enginePreview(readerOf(vector, first), '1.00000001')).rejects.toThrow(/more than 7 decimals/);
  });
});
