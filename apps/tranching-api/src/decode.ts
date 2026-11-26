import type { xdr } from '@stellar/stellar-sdk';
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

/// Event names of the note-token, abs-deal and paying-agent contracts that this
/// indexer knows (see the StellarEvent model). The indexer stores any other
/// topic raw and does not decode it.
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  // note-token
  'issue', 'transfer', 'approve', 'period_rolled', 'weight_frozen',
  // abs-deal
  'subscribed', 'sub_cancelled', 'sub_loan_funded', 'sub_loan_refunded', 'deal_closed',
  'deal_aborted', 'distribution', 'fees_paid', 'interest_paid', 'principal_paid',
  'factor_updated', 'reserve_released', 'reserve_refunded', 'carry_updated', 'residual_paid',
  'enforced', 'matured', 'eligibility_set', 'payout_parked', 'owed_claimed',
  // abs-deal, rank engine
  'rank_lines', 'period_settled', 'trigger_breached',
  // paying-agent
  'period_funded', 'holder_paid', 'push_failed', 'claimed', 'batch_done',
]);

/// Decode one topic or value. When the SDK cannot decode it, keep the raw
/// XDR, so that one odd event never stops the ingestion.
function nativeOrRaw(value: unknown): unknown {
  try {
    return toNative(value);
  } catch {
    try {
      return { xdr: typeof value === 'string' ? value : (value as xdr.ScVal).toXDR('base64') };
    } catch {
      return { xdr: null };
    }
  }
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
  const topics = rawTopics.map(nativeOrRaw);
  const data = nativeOrRaw(rawEvent.value);
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
/// contract; `classIndex` resolves to a tranche through the class index of
/// the registry (0..n-1, senior first).
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
      // No position effect, or a topic that the indexer does not know: no delta.
      return [];
  }
}

// ---------------------------------------------------------------------------
// Readers of the abs-deal events of a payment date.
//
// Each reader takes the topics and the data of one event, in the stored form
// (the Json columns of a StellarEvent row) or straight from `decodeEvent`. An
// amount is a decimal string in the stored form and a bigint from the SDK:
// a reader accepts both and gives a decimal string. A reader gives null when
// the event does not have the shape of its type. It never throws.
// ---------------------------------------------------------------------------

/// The item of one rank line, with the names of the deal configuration file.
export type RankItemKind = 'fee' | 'interest' | 'principal' | 'reserveRefill' | 'residual';

/// On-chain variant of `Item` -> item kind. The boolean tells if the variant
/// has an index: a fee line or a class.
const RANK_ITEMS: ReadonlyMap<string, readonly [RankItemKind, boolean]> = new Map([
  ['Fee', ['fee', true]],
  ['Interest', ['interest', true]],
  ['Principal', ['principal', true]],
  ['ReserveRefill', ['reserveRefill', false]],
  ['Residual', ['residual', false]],
]);

export interface RankItem {
  kind: RankItemKind;
  /// The fee line of a `fee` item, the class of an `interest` or a `principal`
  /// item. Null for the other items.
  index: number | null;
}

/// One line of a `rank_lines` event: one item of one rank that ran.
export interface RankLine {
  /// The id of the rank in the configuration of the deal.
  rank: string;
  item: RankItem;
  due: string;
  paid: string;
  /// The per-note rounding remainder. It goes to the carry.
  dust: string;
}

export interface RankLinesEvent {
  period: number;
  /// True when the enforced order ran, false for the normal order.
  enforced: boolean;
  lines: RankLine[];
}

/// The figures of a `period_settled` event, in base units of the asset.
export interface PeriodSettlement {
  period: number;
  collections: string;
  reserveIn: string;
  carryIn: string;
  /// Reserve cash that the draw ranks took.
  drawn: string;
  /// Cash that left the ledgers: fee lines, paying agent, Seller.
  paidOut: string;
  reserve: string;
  carry: string;
  /// Parked payouts that their recipients did not claim yet.
  owed: string;
  /// Asset balance of the deal after the payment date.
  balance: string;
  /// Cash above the ledgers that the maturity sweep paid to the Seller.
  surplus: string;
}

export interface TriggerBreachedEvent {
  id: string;
  period: number;
}

export interface PayoutParkedEvent {
  recipient: string;
  period: number;
  /// Payout code of the contract: 1 for a fee line, 7 for the residual.
  rank: number;
  amount: string;
}

export interface OwedClaimedEvent {
  recipient: string;
  amount: string;
}

export interface EligibilitySetEvent {
  holder: string;
  eligible: boolean;
}

function listOf(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function flagOf(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/// A u32 of the contract: a period, a class, a fee line, a payout code.
function countOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'bigint') return value >= 0n ? Number(value) : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/// An i128 amount of the contract, as a decimal string.
function amountOf(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
  return null;
}

function readRankItem(value: unknown): RankItem | null {
  const fields = listOf(value);
  const known = RANK_ITEMS.get(textOf(fields?.[0]) ?? '');
  if (!fields || !known) return null;
  const [kind, hasIndex] = known;
  if (!hasIndex) return fields.length === 1 ? { kind, index: null } : null;
  const index = countOf(fields[1]);
  return index !== null && fields.length === 2 ? { kind, index } : null;
}

function readRankLine(value: unknown): RankLine | null {
  // [rank id, item, due, paid, dust]
  const fields = listOf(value);
  const rank = textOf(fields?.[0]);
  const item = readRankItem(fields?.[1]);
  const due = amountOf(fields?.[2]);
  const paid = amountOf(fields?.[3]);
  const dust = amountOf(fields?.[4]);
  if (rank === null || item === null || due === null || paid === null || dust === null) return null;
  return { rank, item, due, paid, dust };
}

/// abs-deal: topics [rank_lines, period], data [enforced, lines]. The lines
/// are in the order of execution.
export function readRankLines(topics: unknown, data: unknown): RankLinesEvent | null {
  const period = countOf(listOf(topics)?.[1]);
  const fields = listOf(data);
  const enforced = flagOf(fields?.[0]);
  const rawLines = listOf(fields?.[1]);
  if (period === null || enforced === null || rawLines === null) return null;
  const lines: RankLine[] = [];
  for (const rawLine of rawLines) {
    const line = readRankLine(rawLine);
    if (line === null) return null;
    lines.push(line);
  }
  return { period, enforced, lines };
}

/// abs-deal: topics [period_settled, period], data [collections, reserve_in,
/// carry_in, drawn, paid_out, reserve, carry, owed, balance, surplus].
export function readPeriodSettled(topics: unknown, data: unknown): PeriodSettlement | null {
  const period = countOf(listOf(topics)?.[1]);
  const fields = listOf(data);
  if (period === null || fields === null || fields.length < 10) return null;
  const amounts: string[] = [];
  for (const field of fields.slice(0, 10)) {
    const amount = amountOf(field);
    if (amount === null) return null;
    amounts.push(amount);
  }
  const [collections, reserveIn, carryIn, drawn, paidOut, reserve, carry, owed, balance, surplus] =
    amounts as [string, string, string, string, string, string, string, string, string, string];
  return { period, collections, reserveIn, carryIn, drawn, paidOut, reserve, carry, owed, balance, surplus };
}

/// The two rules of a settlement, from the event alone.
/// - conserved: collections + opening reserve + opening carry = cash paid out
///   + closing reserve + closing carry.
/// - covered: the balance of the deal covers the reserve, the carry and the
///   amounts owed.
export function settlementChecks(settlement: PeriodSettlement): { conserved: boolean; covered: boolean } {
  const amount = (value: string): bigint => BigInt(value);
  const sources = amount(settlement.collections) + amount(settlement.reserveIn) + amount(settlement.carryIn);
  const uses = amount(settlement.paidOut) + amount(settlement.reserve) + amount(settlement.carry);
  const ledgers = amount(settlement.reserve) + amount(settlement.carry) + amount(settlement.owed);
  return { conserved: sources === uses, covered: amount(settlement.balance) >= ledgers };
}

/// abs-deal: topics [trigger_breached, id], data [period].
export function readTriggerBreached(topics: unknown, data: unknown): TriggerBreachedEvent | null {
  const id = textOf(listOf(topics)?.[1]);
  const period = countOf(listOf(data)?.[0]);
  return id === null || period === null ? null : { id, period };
}

/// abs-deal: topics [payout_parked, recipient], data [period, rank, amount].
export function readPayoutParked(topics: unknown, data: unknown): PayoutParkedEvent | null {
  const recipient = textOf(listOf(topics)?.[1]);
  const fields = listOf(data);
  const period = countOf(fields?.[0]);
  const rank = countOf(fields?.[1]);
  const amount = amountOf(fields?.[2]);
  if (recipient === null || period === null || rank === null || amount === null) return null;
  return { recipient, period, rank, amount };
}

/// abs-deal: topics [owed_claimed, recipient], data [amount].
export function readOwedClaimed(topics: unknown, data: unknown): OwedClaimedEvent | null {
  const recipient = textOf(listOf(topics)?.[1]);
  const amount = amountOf(listOf(data)?.[0]);
  return recipient === null || amount === null ? null : { recipient, amount };
}

/// abs-deal: topics [eligibility_set, holder], data [eligible].
export function readEligibilitySet(topics: unknown, data: unknown): EligibilitySetEvent | null {
  const holder = textOf(listOf(topics)?.[1]);
  const eligible = flagOf(listOf(data)?.[0]);
  return holder === null || eligible === null ? null : { holder, eligible };
}
