import type { OnChainDealConfig } from '../deals/onchain.js';

/**
 * The evidence of one deal: what the network says about it at one moment.
 *
 * - the events of its contracts (the deal, the paying agent, the note
 *   tokens, the oracle), each with the hash of its transaction;
 * - a snapshot of its state: the configuration, the ledgers, the code
 *   hashes, and the counters of each holder in the paying agent.
 *
 * The checks (checks.ts) and the report (report.ts) read this value only.
 * The tool keeps it in a bundle file, because Soroban RPC keeps the events
 * for about 7 days.
 */
export interface ChainEvent {
  contractId: string;
  /** The name of the event: its first topic. */
  type: string;
  /** The topics after the name, as native values. */
  topics: unknown[];
  /** The data, as native values. */
  data: unknown[];
  ledger: number;
  /** The close time of the ledger, in seconds. 0 when it is not known. */
  closedAt: number;
  txHash: string;
  /** The id of the event: the events of a transaction sort by this id. */
  id: string;
}

export interface HolderRow {
  class: number;
  holder: string;
  /** The notes that the holder has now. */
  notes: bigint;
  /** The cumulative counters of the paying agent (`get_holder_totals`). */
  interestPaid: bigint;
  principalPaid: bigint;
  /** The amount that waits in the paying agent for this holder (`get_claimable`). */
  claimableInterest: bigint;
  claimablePrincipal: bigint;
}

export interface CodeHashes {
  deal: string;
  note: string;
  agent: string;
}

export interface DealSnapshot {
  deal: string;
  payingAgent: string;
  notes: string[];
  asset: { contractId: string; symbol: string; decimals: number };
  config: OnChainDealConfig;
  /** The reporter of the oracle. Null for a deal with fixed rates only. */
  reporter: string | null;
  /** The address that deployed the contracts and pushes the holder payments. Null when not known. */
  crank: string | null;
  /** The last fixings that the oracle keeps, oldest first. */
  fixingHistory: { price: bigint; timestamp: bigint }[];
  state: string;
  nextPeriod: number;
  reserve: bigint;
  carry: bigint;
  owedTotal: bigint;
  /** The asset balance of the deal and of the paying agent. */
  balance: bigint;
  agentBalance: bigint;
  perNote: bigint[];
  shortfall: bigint[];
  /** The interest remainder that the paying agent keeps for each class. */
  dust: bigint[];
  holders: HolderRow[];
  code: CodeHashes;
  /** The code of other deals, to show that all run one binary. */
  compare: { deal: string; code: CodeHashes }[];
}

export interface TransactionRow {
  hash: string;
  ledger: number | null;
  /** What the transaction did. */
  step: string;
  /** The source account of the transaction, or null when it is not known. */
  signer: string | null;
}

export interface AccountOperation {
  account: string;
  hash: string;
  createdAt: string;
  /** For example "change_trust EURC" or "subscribe". */
  what: string;
  successful: boolean;
}

export interface Evidence {
  label: string;
  network: string;
  collectedAt: string;
  /** The first ledger of the event window. */
  fromLedger: number;
  latestLedger: number;
  snapshot: DealSnapshot;
  events: ChainEvent[];
  transactions: TransactionRow[];
  /** The operations of the accounts of the --account option. */
  accounts: AccountOperation[];
  /** A fixing for a period, when the oracle events are outside the window. */
  fixings: Record<number, bigint>;
}

/* ---- the bundle file ---- */

const BIGINT_TAG = '$bigint';

/** JSON text with each bigint as `{"$bigint": "123"}`. */
export function toBundle(evidence: Evidence): string {
  const text = JSON.stringify(
    evidence,
    (_key, value: unknown) => (typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value),
    1,
  );
  return `${text}\n`;
}

export function fromBundle(text: string): Evidence {
  return JSON.parse(text, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && BIGINT_TAG in value) {
      const digits = (value as Record<string, unknown>)[BIGINT_TAG];
      if (typeof digits === 'string') return BigInt(digits);
    }
    return value;
  }) as Evidence;
}

/* ---- readers of the event values ---- */

export function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  throw new Error(`An amount was expected, not ${String(value)}.`);
}

export function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`A number was expected, not ${String(value)}.`);
}

/** The events of one type, in chain order. */
export function eventsOf(events: readonly ChainEvent[], contractId: string, type: string): ChainEvent[] {
  return events.filter((event) => event.contractId === contractId && event.type === type);
}

/** Events sort by ledger, then by id inside a ledger. */
export function inChainOrder(events: readonly ChainEvent[]): ChainEvent[] {
  return [...events].sort((left, right) => left.ledger - right.ledger || left.id.localeCompare(right.id));
}
