import { describe, expect, it } from 'vitest';
import { rateLabel } from '../src/metrics.js';

describe('rateLabel', () => {
  it('keeps the labels of the reference deal', () => {
    // Class A: FLOATING, couponBps is the spread over EURIBOR 1M.
    expect(rateLabel('FLOATING', 60)).toBe('EURIBOR 1M + 0.60% (floor 0%)');
    // Classes B and C: FIXED, couponBps is the annual rate.
    expect(rateLabel('FIXED', 100)).toBe('1.00% fixed');
    expect(rateLabel('FIXED', 150)).toBe('1.50% fixed');
  });

  it('builds the label from the rate terms, not from the seniority', () => {
    expect(rateLabel('FLOATING', 125)).toBe('EURIBOR 1M + 1.25% (floor 0%)');
    expect(rateLabel('FIXED', 275)).toBe('2.75% fixed');
    expect(rateLabel('FIXED', 0)).toBe('0.00% fixed');
  });
});
