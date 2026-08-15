/**
 * Client for the tranching indexer API. The dashboard reads note metrics
 * from indexed Postgres here - not live RPC - for sub-second, consistent stats.
 * A note has no NAV and no share price: the investor metrics are the note
 * factor, the outstanding nominal and the cumulative amounts paid.
 */
const BASE =
  process.env.NEXT_PUBLIC_INDEXER_URL?.replace(/\/$/, "") ?? "http://localhost:8080";

export interface TrancheStats {
  trancheId: string;
  /** FUNDING | AMORTIZING | ENFORCED | MATURED | REDEEMED (factor 0). */
  phase: string;
  originalFace: string; // base units (i128 as string)
  outstanding: string; // base units
  /** Outstanding / original face, in percent (100 = par). */
  noteFactorPct: number;
  coupon: {
    allInPct: number;
    rateUnits: number; // 0.001% units (RATE_SCALE 100_000 = 100%)
    pricing: string; // e.g. "EURIBOR 1M + 0.60% (floor 0%)"
  } | null;
  accrued: { days: number; periodDays: number; interest: string } | null;
  cumulative: { interestPaid: string; principalPaid: string };
  lastDistribution: { ts: string; period: number } | null;
  nextPayment: { dueAt: string; estimatedInterest: string } | null;
  ledger: number | null;
  ts: string | null;
}

export interface NotePosition {
  tranche: string; // note-token contract id
  address: string;
  units: string; // whole notes (decimals 0)
  outstandingClaim: string; // base units - units x per-note outstanding
  subscribed: string; // base units paid at par during funding
  interestReceived: string; // base units, cumulative
  principalReceived: string; // base units, cumulative
  updatedAt: string;
}

export interface TrancheHistoryPoint {
  ts: string;
  ledger: number;
  outstanding: string; // base units
  noteFactorPct: number;
  paidInterestCum: string;
  paidPrincipalCum: string;
}

export async function fetchTrancheHistory(
  contractId: string,
  range: string
): Promise<TrancheHistoryPoint[]> {
  try {
    const res = await fetch(`${BASE}/notes/${contractId}/history?range=${range}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    return (await res.json()) as TrancheHistoryPoint[];
  } catch {
    return [];
  }
}

export interface PositionHistoryPoint {
  ts: string;
  value: number; // remaining claim, base units (units x per-note outstanding)
  receivedCum: number; // cumulative cash received (interest + principal), base units
}

export async function fetchUserPositionHistory(
  contractId: string,
  address: string,
  range: string
): Promise<PositionHistoryPoint[]> {
  try {
    const res = await fetch(
      `${BASE}/users/${address}/notes/${contractId}/history?range=${range}`,
      { cache: "no-store" }
    );
    if (!res.ok) return [];
    return (await res.json()) as PositionHistoryPoint[];
  } catch {
    return [];
  }
}

export async function fetchTrancheStats(
  contractId: string
): Promise<TrancheStats | null> {
  try {
    const res = await fetch(`${BASE}/notes/${contractId}/stats`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as TrancheStats;
  } catch {
    return null;
  }
}

export interface NoteEvent {
  id: string;
  type: string;
  ts: string;
  ledger: number;
  topic: unknown[];
  data: unknown;
}

export async function fetchNoteEvents(
  contractId: string,
  limit = 8
): Promise<NoteEvent[]> {
  try {
    const res = await fetch(`${BASE}/notes/${contractId}/events?limit=${limit}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    return (await res.json()) as NoteEvent[];
  } catch {
    return [];
  }
}

export async function fetchUserPositions(address: string): Promise<NotePosition[]> {
  try {
    const res = await fetch(`${BASE}/users/${address}/positions`, { cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()) as NotePosition[];
  } catch {
    return [];
  }
}
