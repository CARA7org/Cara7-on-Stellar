/**
 * Client for the tranching-api registry: which ABS deals exist and which
 * Soroban contracts back them (abs-deal escrow/waterfall, one note token
 * per class, paying agent). Same fail-soft pattern as indexer.ts.
 */
const BASE =
  process.env.NEXT_PUBLIC_INDEXER_URL?.replace(/\/$/, "") ?? "http://localhost:8080";

import type { TrancheStats } from "./indexer";

export interface TrancheInfo {
  id: number;
  dealId: number;
  dealName: string;
  name: string;
  /** On-chain class index in the deal, senior first (0 = Class A). Old rows can lack it. */
  classIndex?: number | null;
  /** Display label only. Several classes of one deal can have the same label. */
  seniority: "SENIOR" | "MEZZANINE" | "JUNIOR";
  /** FLOATING: EURIBOR 1M + spread, floor 0%. FIXED: one annual rate. */
  rateKind: "FLOATING" | "FIXED";
  /** FIXED: the annual rate in bps. FLOATING: the spread over EURIBOR 1M in bps. */
  couponBps: number;
  contractId: string; // note-token contract of the class
  baseAssetId: string;
  originalFace: string; // base units (i128 as string)
  assetSymbol: string;
  assetDecimals: number;
  stats: TrancheStats | null;
}

export interface TrancheDetail extends TrancheInfo {
  deal: { name: string; description: string | null };
}

export async function fetchTranches(): Promise<TrancheInfo[]> {
  try {
    const res = await fetch(`${BASE}/api/tranches`, { cache: "no-store" });
    if (!res.ok) return [];
    const body = (await res.json()) as { tranches: TrancheInfo[] };
    return body.tranches;
  } catch {
    return [];
  }
}

export interface DealInfo {
  id: number;
  name: string;
  description: string | null;
  dealContractId: string | null; // abs-deal: escrow + closing DvP + waterfall v4
  payingAgentContractId: string | null;
  /** FUNDING | AMORTIZING | ENFORCED | MATURED (live from the deal contract). */
  phase: string;
  closedAt: string | null;
}

export async function fetchDeals(): Promise<DealInfo[]> {
  try {
    const res = await fetch(`${BASE}/api/deals`, { cache: "no-store" });
    if (!res.ok) return [];
    const body = (await res.json()) as { deals: DealInfo[] };
    return body.deals;
  } catch {
    return [];
  }
}

export interface DistributionPerClass {
  tranche: string | null; // note-token contract id (null if unregistered)
  class: number; // on-chain class index, senior first (0 = Class A)
  interest: string;
  principal: string;
  shortfall: string;
}

export interface Distribution {
  period: number;
  ts: string;
  ledger: number;
  collections: string;
  reserveReleased: string;
  carryIn: string;
  ada: string; // Available Distribution Amount
  total: string;
  residual: string;
  fees: string;
  reserveRefunded: string;
  carryOut: string;
  perClass: DistributionPerClass[];
  payments: Record<string, string>;
}

export interface DistributionSchedule {
  periodDays: number;
  periodNumber: number;
  dueAt: string;
}

export interface DistributionsResponse {
  distributions: Distribution[];
  schedule: DistributionSchedule | null;
}

export async function fetchDistributions(
  dealId: number
): Promise<DistributionsResponse> {
  try {
    const res = await fetch(`${BASE}/api/deals/${dealId}/distributions`, {
      cache: "no-store",
    });
    if (!res.ok) return { distributions: [], schedule: null };
    return (await res.json()) as DistributionsResponse;
  } catch {
    return { distributions: [], schedule: null };
  }
}

export async function fetchTranche(id: string): Promise<TrancheDetail | null> {
  try {
    const res = await fetch(`${BASE}/api/tranches/${id}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { tranche: TrancheDetail };
    return body.tranche;
  } catch {
    return null;
  }
}
