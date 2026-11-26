/**
 * Decimal amounts as strings. The math uses BigInt only, never a float.
 *
 * An amount in a deal config or in an HTTP body is a decimal string in
 * units of the settlement asset, for example "10" or "0.01". The contracts
 * take base units: the amount times 10 ^ decimals of the asset.
 */
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** 100 % in rate units of 0.001 %, as in the contracts (RATE_SCALE). */
export const RATE_SCALE = 100_000n;

/** The digits of a percent in rate units: 3 digits give 0.001 %. */
const RATE_DECIMALS = 3;

/**
 * "12.5" with 7 decimals gives 125000000n. A value with more decimals than
 * `decimals` gives an error. The function never rounds.
 */
export function toBaseUnits(value: string, decimals: number, label = 'The amount'): bigint {
  const match = DECIMAL.exec(value);
  if (!match) {
    throw new Error(`${label} "${value}" is not a decimal amount such as "10" or "0.01".`);
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    throw new Error(`${label} "${value}" has more than ${decimals} decimals.`);
  }
  const scaled = fraction.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(scaled.length > 0 ? scaled : '0');
}

/** 125000000n with 7 decimals gives "12.5". */
export function formatUnits(baseUnits: bigint, decimals: number): string {
  const negative = baseUnits < 0n;
  const digits = (negative ? -baseUnits : baseUnits).toString().padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  const fraction = digits.slice(cut).replace(/0+$/, '');
  return `${negative ? '-' : ''}${digits.slice(0, cut)}${fraction.length > 0 ? `.${fraction}` : ''}`;
}

/** A number for a JSON view. The value goes through its exact decimal string. */
export function toDisplayNumber(baseUnits: bigint, decimals: number): number {
  return Number(formatUnits(baseUnits, decimals));
}

/** The largest JSON number that `numberToBaseUnits` accepts. */
const MAX_NUMBER_AMOUNT = 1e15;

/**
 * An older JSON number, for example 12.5, to base units. `toFixed` rounds
 * the exact value of the number to the asset decimals. No multiplication
 * of floats occurs.
 */
export function numberToBaseUnits(value: number, decimals: number, label = 'The amount'): bigint {
  if (!Number.isFinite(value) || value < 0 || value >= MAX_NUMBER_AMOUNT) {
    throw new Error(`${label} ${value} is not an amount from 0 to ${MAX_NUMBER_AMOUNT}.`);
  }
  return toBaseUnits(value.toFixed(decimals), decimals, label);
}

/** True when `value` is a whole multiple of `unit`. Both are decimal strings. */
export function isWholeMultiple(value: string, unit: string): boolean {
  const scale = Math.max(fractionDigits(value), fractionDigits(unit));
  const scaledUnit = toBaseUnits(unit, scale);
  return scaledUnit > 0n && toBaseUnits(value, scale) % scaledUnit === 0n;
}

function fractionDigits(value: string): number {
  return DECIMAL.exec(value)?.[2]?.length ?? 0;
}

/** A percent string to rate units of 0.001 %: "0.60" gives 600n. */
export function percentToRateUnits(value: string, label = 'The rate'): bigint {
  return toBaseUnits(value, RATE_DECIMALS, label);
}

/**
 * Rate units of 0.001 % to basis points: 600n gives 60. One basis point is
 * 10 rate units. A rate that is not a whole number of basis points gives an
 * error, because the registry keeps whole basis points.
 */
export function rateUnitsToBps(units: bigint): number {
  if (units % 10n !== 0n) {
    const percent = formatUnits(units, RATE_DECIMALS);
    throw new Error(`The rate ${percent} % is not a whole number of basis points.`);
  }
  return Number(units / 10n);
}
