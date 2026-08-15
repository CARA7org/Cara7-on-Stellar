/** Format a base-unit i128 (as string) into a human amount with `decimals` dp. */
export function fromBaseUnits(value: string | bigint, decimals: number): number {
  const v = BigInt(value);
  return Number(v) / 10 ** decimals;
}

/** Compact token amount, e.g. 1_234_500_0000000 → "123.45". */
export function formatAmount(value: string | bigint, decimals: number, dp = 2): string {
  const n = fromBaseUnits(value, decimals);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(dp);
}

/** Human token quantity with thousands separators, e.g. 10000 → "10,000.00". */
export function formatQty(n: number, dp = 2): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Compact amount for axis ticks: 14000 → "14.0K" (fits a 64px axis). */
export function formatCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

/** A fractional return (e.g. 0.0514) → "+5.14%" / "-2.10%" / "-" when null. */
export function formatPct(ret: number | null | undefined): string {
  if (ret == null) return "-";
  const pct = ret * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}
