import { describe, expect, it } from 'vitest';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { decodeEvent, positionDeltas, type DecodedEvent } from '../src/decode.js';

function eventOf(
  type: string,
  topics: unknown[],
  data: unknown,
  contractId = 'CNOTE',
): DecodedEvent {
  return {
    id: '0001',
    ledger: 1,
    ts: new Date('2026-01-01T00:00:00Z'),
    contractId,
    type,
    topics: [type, ...topics],
    data,
  };
}

describe('positionDeltas', () => {
  it('credits the subscriber on an issue (closing)', () => {
    const deltas = positionDeltas(eventOf('issue', ['GINV'], '1000'));
    expect(deltas).toEqual([
      { kind: 'units', tranche: 'CNOTE', address: 'GINV', unitsDelta: 1000n },
    ]);
  });

  it('moves the notes on a secondary transfer', () => {
    const deltas = positionDeltas(eventOf('transfer', ['GFROM', 'GTO'], '250'));
    expect(deltas).toEqual([
      { kind: 'units', tranche: 'CNOTE', address: 'GFROM', unitsDelta: -250n },
      { kind: 'units', tranche: 'CNOTE', address: 'GTO', unitsDelta: 250n },
    ]);
  });

  it('tracks the cost basis on subscribed / sub_cancelled', () => {
    // abs-deal: data [class, notes, amount]
    const subscribed = positionDeltas(
      eventOf('subscribed', ['GINV'], ['1', '700', '700000000000'], 'CDEAL'),
    );
    expect(subscribed).toEqual([
      {
        kind: 'subscription',
        dealContractId: 'CDEAL',
        classIndex: 1,
        address: 'GINV',
        subscribedDelta: 700000000000n,
      },
    ]);
    const cancelled = positionDeltas(
      eventOf('sub_cancelled', ['GINV'], ['1', '700', '700000000000'], 'CDEAL'),
    );
    expect(cancelled[0]).toMatchObject({ subscribedDelta: -700000000000n });
  });

  it('separates interest from principal on holder_paid', () => {
    // paying-agent: data [period, class, interest, principal]
    const deltas = positionDeltas(
      eventOf('holder_paid', ['GHOLD'], ['3', '0', '234083000', '98151333000'], 'CAGENT'),
    );
    expect(deltas).toEqual([
      {
        kind: 'payment',
        agentContractId: 'CAGENT',
        classIndex: 0,
        address: 'GHOLD',
        interestDelta: 234083000n,
        principalDelta: 98151333000n,
      },
    ]);
  });

  it('attributes a claimed event to its class', () => {
    // paying-agent: data [class, interest, principal]
    const deltas = positionDeltas(eventOf('claimed', ['GHOLD'], ['2', '400', '200'], 'CAGENT'));
    expect(deltas).toEqual([
      {
        kind: 'payment',
        agentContractId: 'CAGENT',
        classIndex: 2,
        address: 'GHOLD',
        interestDelta: 400n,
        principalDelta: 200n,
      },
    ]);
  });

  it('ignores the events with no position effect', () => {
    expect(positionDeltas(eventOf('distribution', ['1'], ['0', '0', '0', '0']))).toEqual([]);
    expect(positionDeltas(eventOf('period_rolled', [], ['1', '0', '0']))).toEqual([]);
    expect(positionDeltas(eventOf('deal_closed', [], ['0', '0', '0']))).toEqual([]);
    expect(positionDeltas(eventOf('approve', ['GA', 'GB'], ['10', '100']))).toEqual([]);
  });

  it('attributes a payment of class 3 (4th class) to class 3', () => {
    const deltas = positionDeltas(
      eventOf('holder_paid', ['GHOLD'], ['2', '3', '500', '0'], 'CAGENT'),
    );
    expect(deltas[0]).toMatchObject({ kind: 'payment', classIndex: 3 });
  });

  it('gives no position delta for the whitelist, parked payout and rank engine topics', () => {
    expect(positionDeltas(eventOf('eligibility_set', ['GINV'], [true], 'CDEAL'))).toEqual([]);
    expect(positionDeltas(eventOf('payout_parked', ['GHOLD'], [1, 1, '100'], 'CDEAL'))).toEqual([]);
    expect(positionDeltas(eventOf('owed_claimed', ['GHOLD'], ['100'], 'CDEAL'))).toEqual([]);
    expect(positionDeltas(eventOf('rank_lines', [1], [false, [['fees', ['Fee', 0], '50', '50', '0']]], 'CDEAL'))).toEqual([]);
    expect(positionDeltas(eventOf('period_settled', [1], ['0', '0', '0', '0', '0', '0', '0', '0', '0', '0'], 'CDEAL'))).toEqual([]);
    expect(positionDeltas(eventOf('trigger_breached', ['seq'], [1], 'CDEAL'))).toEqual([]);
  });
});

describe('decodeEvent', () => {
  const base = {
    id: '0000000001-0000000001',
    ledger: 5,
    ledgerClosedAt: '2026-11-17T00:00:00Z',
    contractId: 'CDEAL',
  };

  it('decodes an unknown topic with a void body', () => {
    const event = decodeEvent({
      ...base,
      topic: [xdr.ScVal.scvSymbol('topic_of_another_contract'), nativeToScVal(3, { type: 'u32' })],
      value: xdr.ScVal.scvVoid(),
    });
    expect(event.type).toBe('topic_of_another_contract');
    expect(event.topics).toEqual(['topic_of_another_contract', 3]);
    expect(event.data).toBeNull();
  });

  it('keeps the raw XDR of a value that the SDK cannot decode', () => {
    const event = decodeEvent({
      ...base,
      topic: [xdr.ScVal.scvSymbol('topic_of_another_contract').toXDR('base64')],
      value: 'not-an-xdr-value',
    });
    expect(event.type).toBe('topic_of_another_contract');
    expect(event.data).toEqual({ xdr: 'not-an-xdr-value' });
  });
});
