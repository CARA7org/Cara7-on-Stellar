import { describe, expect, it } from 'vitest';
import { positionDeltas, type DecodedEvent } from '../src/decode.js';

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
});
