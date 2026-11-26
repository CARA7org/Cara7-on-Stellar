import { describe, expect, it } from 'vitest';
import { couponRateUnits, type ClassTermsView } from '../src/snapshot.js';

// Rates are in units of 0.001 %: 2209 is 2.209 %.
const FIXING = 2209n;

function floating(spread: bigint, floors: Partial<Pick<ClassTermsView, 'floor' | 'index_floor'>> = {}): ClassTermsView {
  return { rate: ['Floating', spread], total_notes: 10n, ...floors };
}

describe('couponRateUnits', () => {
  it('gives the rate of a fixed class, with or without a fixing', () => {
    const fixed: ClassTermsView = { rate: ['Fixed', 1500n], total_notes: 10n };
    expect(couponRateUnits(fixed, FIXING)).toBe(1500);
    expect(couponRateUnits(fixed, null)).toBe(1500);
    expect(couponRateUnits({ ...fixed, floor: null, index_floor: null }, FIXING)).toBe(1500);
  });

  it('keeps the rule of a deal of the earlier code: fixing plus spread, not below 0', () => {
    // No floor field in the configuration of the deal.
    expect(couponRateUnits(floating(600n), FIXING)).toBe(2809);
    expect(couponRateUnits(floating(600n), -1000n)).toBe(0);
    expect(couponRateUnits(floating(600n), null)).toBe(0);
  });

  it('gives the same result when the floors of a new deal are null', () => {
    const terms = floating(600n, { floor: null, index_floor: null });
    expect(couponRateUnits(terms, FIXING)).toBe(2809);
    // A rate below 0 gives no interest in the contract.
    expect(couponRateUnits(terms, -1000n)).toBe(0);
  });

  it('applies the floor of the all-in rate', () => {
    expect(couponRateUnits(floating(600n, { floor: 0n }), -1000n)).toBe(0);
    expect(couponRateUnits(floating(600n, { floor: 3000n }), FIXING)).toBe(3000);
    expect(couponRateUnits(floating(600n, { floor: 2000n }), FIXING)).toBe(2809);
    // A floor below 0 does not give a rate below 0.
    expect(couponRateUnits(floating(600n, { floor: -500n }), -2000n)).toBe(0);
  });

  it('applies the floor of the index before the spread', () => {
    expect(couponRateUnits(floating(700n, { index_floor: 0n }), -1000n)).toBe(700);
    expect(couponRateUnits(floating(700n, { index_floor: 0n }), FIXING)).toBe(2909);
    // Both floors: the index floor first, then the all-in floor.
    expect(couponRateUnits(floating(600n, { index_floor: 0n, floor: 1000n }), -1000n)).toBe(1000);
    expect(couponRateUnits(floating(600n, { index_floor: 2500n, floor: 1000n }), FIXING)).toBe(3100);
  });

  it('never gives NaN', () => {
    // A rate that the RPC did not decode as the contract writes it.
    const odd = { rate: ['Floating', undefined], total_notes: 10n } as unknown as ClassTermsView;
    expect(couponRateUnits(odd, FIXING)).toBe(0);
    const nested = { rate: ['Floating', { spread: 600n }], total_notes: 10n } as unknown as ClassTermsView;
    expect(couponRateUnits(nested, FIXING)).toBe(0);
    const text = { rate: ['Fixed', '1500'], total_notes: 10n } as unknown as ClassTermsView;
    expect(couponRateUnits(text, null)).toBe(1500);
    for (const terms of [odd, nested, text, floating(600n), floating(600n, { floor: null })]) {
      expect(Number.isInteger(couponRateUnits(terms, FIXING))).toBe(true);
      expect(Number.isInteger(couponRateUnits(terms, null))).toBe(true);
    }
  });
});
