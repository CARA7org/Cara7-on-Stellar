import type { TrancheInfo } from "@/services/registry";

/**
 * Rate terms of a class come from the registry (`rateKind`, `couponBps`):
 * - FLOATING: EURIBOR 1M + spread, with a 0% floor. `couponBps` is the
 *   spread. The all-in rate is the rate of the current period that the
 *   indexer reads on chain (`stats.coupon.allInPct`). Without it, the stored
 *   fixing below gives the all-in rate.
 * - FIXED: `couponBps` is the annual rate.
 * Reference deal: Class A EURIBOR 1M + 0.60% (about 2.81% all-in), Class B
 * 1.00% fixed, Class C 1.50% fixed.
 */
/**
 * Risk assumption displayed against the loss cushions (decided 2026-08-03):
 * an assumed cumulative pool default rate, absorbed first by the junior
 * class (first loss), then B, then A. Display-only - the waterfall never
 * simulates it.
 */
export const ASSUMED_DEFAULT_RATE_PCT = 2.5;

export const EURIBOR_1M = {
  ratePct: 2.209,
  fixingDate: "2026-07-31",
  source: "EMMI via euribor-rates.eu",
};

/**
 * Pricing terms as data, not prose: the display string is built by the
 * locale dictionary (`dictionary.ratePricingLabel`) so EN/FR both render it.
 */
export type TranchePricing =
  | { kind: "fixed" }
  | { kind: "floating"; spreadPct: number };

export interface TrancheRate {
  /** All-in annual rate in percent, e.g. 2.809. */
  allInPct: number;
  allIn: string; // e.g. "2.81%"
  pricing: TranchePricing;
}

/**
 * Displayed rate for a tranche. `euriborFixingPct` defaults to the stored
 * fixing so a live oracle read can be wired in later without touching the
 * call sites. The fixing applies only when the indexer has no all-in rate.
 */
export function trancheRate(
  tranche: Pick<TrancheInfo, "rateKind" | "couponBps" | "stats">,
  euriborFixingPct: number = EURIBOR_1M.ratePct
): TrancheRate {
  const termsPct = tranche.couponBps / 100;
  if (tranche.rateKind !== "FLOATING") {
    return { allInPct: termsPct, allIn: `${termsPct.toFixed(2)}%`, pricing: { kind: "fixed" } };
  }
  // FLOATING: the terms give the spread. The all-in rate has a 0% floor.
  const allInPct =
    tranche.stats?.coupon?.allInPct ?? Math.max(0, euriborFixingPct + termsPct);
  return {
    allInPct,
    allIn: `${allInPct.toFixed(2)}%`,
    pricing: { kind: "floating", spreadPct: termsPct },
  };
}
