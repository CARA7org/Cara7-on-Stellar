import { describe, expect, it } from 'vitest';
import { loadPool, poolAggregates, vinYear, VIN_PATTERN } from '../src/asset-pool/pool.js';
import { periodCollections } from '../src/waterfall/collections.js';

describe('asset pool sample', () => {
  const pool = loadPool();

  it('holds exactly 20 vehicles', () => {
    expect(pool.vehicles).toHaveLength(20);
  });

  it('every VIN matches the 17-char pattern without I/O/Q', () => {
    for (const entry of pool.vehicles) {
      expect(entry.vin).toMatch(VIN_PATTERN);
    }
  });

  it('every VIN year code (position 10) matches yearOfRegistration', () => {
    for (const entry of pool.vehicles) {
      expect(vinYear(entry.vin)).toBe(entry.vehicle.yearOfRegistration);
    }
  });

  it('VINs are unique, as are contract and obligor ids', () => {
    const vins = new Set(pool.vehicles.map((entry) => entry.vin));
    const contracts = new Set(pool.vehicles.map((entry) => entry.loan.contractId));
    const obligors = new Set(pool.vehicles.map((entry) => entry.obligor.obligorId));
    expect(vins.size).toBe(20);
    expect(contracts.size).toBe(20);
    expect(obligors.size).toBe(20);
  });

  it('aggregates are consistent with the raw entries', () => {
    const aggregates = poolAggregates(pool) as Record<string, number>;
    expect(aggregates.vehicleCount).toBe(20);
    const manualTotal = pool.vehicles.reduce((sum, entry) => sum + entry.loan.currentPrincipal, 0);
    expect(aggregates.totalCurrentPrincipal).toBe(manualTotal);
    expect(aggregates.performingPercentage).toBeLessThan(100); // one RSTR contract in the sample
    expect(aggregates.weightedAverageRate).toBeGreaterThan(0.03);
    expect(aggregates.weightedAverageRate).toBeLessThan(0.09);
  });
});

describe('period collections', () => {
  it('collects PERF-without-arrears installments and reports the missed ones', () => {
    const { totalMonthlyDue, collected, missed } = periodCollections();
    expect(collected).toBeGreaterThan(0);
    expect(collected).toBeLessThan(totalMonthlyDue);
    // The e-C4 (12 DPD) and the restructured Dacia Spring miss their installment.
    expect(missed.map((entry) => entry.contractId).sort()).toEqual([
      'BSF5-2023-0006',
      'BSF5-2023-0007',
    ]);
    expect(collected + missed.reduce((sum, entry) => sum + entry.amount, 0)).toBe(totalMonthlyDue);
  });
});
