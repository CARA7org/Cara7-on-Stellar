import { toNative } from './stellar.js';

export interface DecodedEvent {
  id: string;
  ledger: number;
  ts: Date;
  contractId: string;
  type: string;
  topics: unknown[];
  data: unknown;
}

/// Normalize a raw RPC event. The first topic is the event name (see the
/// comment on the StellarEvent model for the full note-token / abs-deal /
/// paying-agent vocabulary).
export function decodeEvent(rawEvent: {
  id: unknown;
  ledger: unknown;
  ledgerClosedAt: string;
  contractId: unknown;
  topic?: unknown[];
  topics?: unknown[];
  value: unknown;
}): DecodedEvent {
  const rawTopics: unknown[] = rawEvent.topic ?? rawEvent.topics ?? [];
  const topics = rawTopics.map(toNative);
  const data = toNative(rawEvent.value);
  const type = String(topics[0] ?? 'unknown');
  return {
    id: String(rawEvent.id),
    ledger: Number(rawEvent.ledger),
    ts: new Date(rawEvent.ledgerClosedAt),
    contractId: String(rawEvent.contractId),
    type,
    topics,
    data,
  };
}

/// Note movements (issue at closing, secondary transfers) - the tranche is
/// the note-token contract that emitted the event.
export interface UnitsDelta {
  kind: 'units';
  tranche: string;
  address: string;
  unitsDelta: bigint;
}

/// Subscription cost basis (at par, in base units) - emitted by the abs-deal
/// contract; `classIndex` resolves to a tranche through the registry
/// (SENIOR=0, MEZZANINE=1, JUNIOR=2).
export interface SubscriptionDelta {
  kind: 'subscription';
  dealContractId: string;
  classIndex: number;
  address: string;
  subscribedDelta: bigint;
}

/// Payments received by a holder (push or claim) - emitted by the paying
/// agent; `classIndex` resolves to a tranche through the deal's registry.
export interface PaymentDelta {
  kind: 'payment';
  agentContractId: string;
  classIndex: number;
  address: string;
  interestDelta: bigint;
  principalDelta: bigint;
}

export type PositionDelta = UnitsDelta | SubscriptionDelta | PaymentDelta;

function dataArray(event: DecodedEvent): string[] {
  return Array.isArray(event.data) ? (event.data as string[]) : [String(event.data)];
}

/// Position deltas implied by an event; feeds user_position. Event names are
/// disjoint across contracts, so a single dispatcher is enough.
export function positionDeltas(event: DecodedEvent): PositionDelta[] {
  const topics = event.topics;
  switch (event.type) {
    case 'issue': {
      // note-token: topics [issue, to], data notes
      return [
        {
          kind: 'units',
          tranche: event.contractId,
          address: String(topics[1]),
          unitsDelta: BigInt(dataArray(event)[0] ?? '0'),
        },
      ];
    }
    case 'transfer': {
      // note-token: topics [transfer, from, to], data notes
      const notes = BigInt(dataArray(event)[0] ?? '0');
      return [
        { kind: 'units', tranche: event.contractId, address: String(topics[1]), unitsDelta: -notes },
        { kind: 'units', tranche: event.contractId, address: String(topics[2]), unitsDelta: notes },
      ];
    }
    case 'subscribed':
    case 'sub_cancelled': {
      // abs-deal: topics [type, investor], data [class, notes, amount]
      const data = dataArray(event);
      const amount = BigInt(data[2] ?? '0');
      return [
        {
          kind: 'subscription',
          dealContractId: event.contractId,
          classIndex: Number(data[0] ?? 0),
          address: String(topics[1]),
          subscribedDelta: event.type === 'subscribed' ? amount : -amount,
        },
      ];
    }
    case 'holder_paid': {
      // paying-agent: topics [holder_paid, holder], data [period, class, interest, principal]
      const data = dataArray(event);
      return [
        {
          kind: 'payment',
          agentContractId: event.contractId,
          classIndex: Number(data[1] ?? 0),
          address: String(topics[1]),
          interestDelta: BigInt(data[2] ?? '0'),
          principalDelta: BigInt(data[3] ?? '0'),
        },
      ];
    }
    case 'claimed': {
      // paying-agent: topics [claimed, holder], data [class, interest, principal]
      const data = dataArray(event);
      return [
        {
          kind: 'payment',
          agentContractId: event.contractId,
          classIndex: Number(data[0] ?? 0),
          address: String(topics[1]),
          interestDelta: BigInt(data[1] ?? '0'),
          principalDelta: BigInt(data[2] ?? '0'),
        },
      ];
    }
    default:
      return [];
  }
}
