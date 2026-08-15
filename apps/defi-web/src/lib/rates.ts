import type { TrancheInfo } from "@/services/registry";

/**
 * Prospectus rate terms for the Bavarian Sky French Auto Leases 5 classes:
 * - Class A (SENIOR): floating, EURIBOR 1M + 0.60% with a 0% floor. The
 *   all-in comes from the registry's couponBps (the rate applied to the
 *   current period).
 * - Class B (MEZZANINE): 1.00% fixed.
 * - Class C (JUNIOR): 1.50% fixed.
 * B/C all-ins are the CONTRACTUAL fixed rates - the registry may still hold
 * pre-revamp coupon values, so couponBps is only trusted for the senior
 * all-in. See docs/tranche-rates.md.
 */
/**
 * Risk assumption displayed against the loss cushions (Eric, 2026-08-03):
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

const SENIOR_SPREAD_PCT = 0.6;

/**
 * Pricing terms as data, not prose: the display string is built by the
 * locale dictionary (`dictionary.ratePricingLabel`) so EN/FR both render it.
 */
export type TranchePricing =
  | { kind: "fixed" }
  | { kind: "floating"; spreadPct: number }
  | { kind: "refixPending" };

export interface TrancheRate {
  allIn: string; // e.g. "2.81%"
  pricing: TranchePricing;
}

/**
 * Displayed rate for a tranche. `euriborFixingPct` defaults to the stored
 * fixing so a live oracle read can be wired in later without touching the
 * call sites.
 */
export function trancheRate(
  tranche: Pick<TrancheInfo, "seniority" | "couponBps">,
  euriborFixingPct: number = EURIBOR_1M.ratePct
): TrancheRate {
  if (tranche.seniority === "MEZZANINE")
    return { allIn: "1.00%", pricing: { kind: "fixed" } };
  if (tranche.seniority === "JUNIOR")
    return { allIn: "1.50%", pricing: { kind: "fixed" } };
  // SENIOR: only claim the EURIBOR breakdown when the registry all-in
  // actually equals fixing + spread - otherwise the registry has not been
  // refixed yet and showing both numbers side by side would contradict itself.
  const allIn = `${(tranche.couponBps / 100).toFixed(2)}%`;
  const expectedBps = Math.round((euriborFixingPct + SENIOR_SPREAD_PCT) * 100);
  return Math.abs(tranche.couponBps - expectedBps) <= 2
    ? { allIn, pricing: { kind: "floating", spreadPct: SENIOR_SPREAD_PCT } }
    : { allIn, pricing: { kind: "refixPending" } };
}
