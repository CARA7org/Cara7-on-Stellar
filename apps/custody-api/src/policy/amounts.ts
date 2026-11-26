// Token amounts as BigInt base units. No floating point anywhere.

/// "250.5" with 7 decimals gives 2505000000n.
export function toBaseUnits(decimal: string, decimals: number): bigint {
  const [whole = '0', fraction = ''] = decimal.split('.');
  if (fraction.length > decimals) {
    throw new Error(`The amount ${decimal} has more than ${decimals} decimals.`);
  }
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/// 2505000000n with 7 decimals gives "250.5".
export function formatUnits(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / scale;
  const fraction = absolute % scale;
  if (fraction === 0n) return `${sign}${whole}`;
  const digits = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${sign}${whole}.${digits}`;
}
