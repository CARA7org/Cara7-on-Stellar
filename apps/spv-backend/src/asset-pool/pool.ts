import { readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../paths.js';

export interface PoolVehicle {
  vin: string;
  vehicle: {
    manufacturer: string;
    model: string;
    energy: string;
    yearOfRegistration: number;
    mileageOdometer: number;
    originalValuation: number;
    currentValuation: number;
    residualValue: number;
    originalLtv: number;
  };
  battery: {
    serialNumber: string;
    manufacturer: string;
    chemistry: string;
    capacityKwh: number;
    sohPercent: number;
    chargeCycles: number;
  };
  loan: {
    contractId: string;
    productType: string;
    originationDate: string;
    maturityDate: string;
    originalTermMonths: number;
    remainingTermMonths: number;
    originalPrincipal: number;
    currentPrincipal: number;
    interestRateBps: number;
    monthlyPayment: number;
    accountStatus: string;
    daysPastDue: number;
    arrearsAmount: number;
  };
  obligor: {
    obligorId: string;
    legalType: string;
    country: string;
    region: string;
    employmentStatus: string;
    creditScoreBand: string;
  };
}

export interface Pool {
  poolId: string;
  dealName: string;
  cutOffDate: string;
  currencyLabel: string;
  note: string;
  vehicles: PoolVehicle[];
}

/// VIN rule (ESMA/ISO 3779 research, see README): 17 characters, I/O/Q excluded.
export const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

/// Model-year code at position 10 (30-year cycle; U and Z are also excluded from THIS code).
const YEAR_CODES: Record<string, number> = { M: 2021, N: 2022, P: 2023, R: 2024, S: 2025, T: 2026 };

export function vinYear(vin: string): number | null {
  return YEAR_CODES[vin.charAt(9)] ?? null;
}

let cachedPool: Pool | null = null;

export function loadPool(): Pool {
  if (!cachedPool) {
    const raw = readFileSync(path.join(projectRoot, 'src', 'asset-pool', 'data', 'pool.json'), 'utf8');
    cachedPool = JSON.parse(raw) as Pool;
  }
  return cachedPool;
}

/// Pool-level aggregates, naming aligned with the CARA7 scaffold's
/// PublicPoolMetadata (totalFinancedAmount, WAM, WAR...).
export function poolAggregates(pool: Pool): Record<string, unknown> {
  const vehicles = pool.vehicles;
  const totalCurrent = vehicles.reduce((sum, entry) => sum + entry.loan.currentPrincipal, 0);
  const totalOriginal = vehicles.reduce((sum, entry) => sum + entry.loan.originalPrincipal, 0);
  const weightedAverageMaturity =
    vehicles.reduce((sum, entry) => sum + entry.loan.remainingTermMonths * entry.loan.currentPrincipal, 0) /
    totalCurrent;
  const weightedAverageRate =
    vehicles.reduce((sum, entry) => sum + (entry.loan.interestRateBps / 10000) * entry.loan.currentPrincipal, 0) /
    totalCurrent;
  const performing = vehicles.filter((entry) => entry.loan.accountStatus === 'PERF');
  const totalArrears = vehicles.reduce((sum, entry) => sum + entry.loan.arrearsAmount, 0);
  const monthlyCollections = vehicles.reduce((sum, entry) => sum + entry.loan.monthlyPayment, 0);
  const averageSoh = vehicles.reduce((sum, entry) => sum + entry.battery.sohPercent, 0) / vehicles.length;

  return {
    vehicleCount: vehicles.length,
    contractCount: vehicles.length,
    debtorCount: new Set(vehicles.map((entry) => entry.obligor.obligorId)).size,
    totalFinancedAmount: totalOriginal,
    totalCurrentPrincipal: totalCurrent,
    weightedAverageMaturityMonths: Number(weightedAverageMaturity.toFixed(1)),
    weightedAverageRate: Number(weightedAverageRate.toFixed(4)),
    performingPercentage: Number(((performing.length / vehicles.length) * 100).toFixed(1)),
    totalArrears,
    monthlyCollections,
    averageBatterySohPercent: Number(averageSoh.toFixed(1)),
  };
}
