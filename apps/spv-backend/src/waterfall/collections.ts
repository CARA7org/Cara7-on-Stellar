import { loadPool } from '../asset-pool/pool.js';

/**
 * Payment collection: one period's collection = the sum of the monthly
 * payments of the pool's performing loans (RSTR/arrears contracts miss their
 * installment this month - exactly what the cascade has to absorb).
 * Amount in EURC display units.
 */
export function periodCollections(): {
  totalMonthlyDue: number;
  collected: number;
  missed: { contractId: string; amount: number; accountStatus: string; daysPastDue: number }[];
} {
  const pool = loadPool();
  let collected = 0;
  let totalMonthlyDue = 0;
  const missed: { contractId: string; amount: number; accountStatus: string; daysPastDue: number }[] = [];
  for (const entry of pool.vehicles) {
    totalMonthlyDue += entry.loan.monthlyPayment;
    if (entry.loan.accountStatus === 'PERF' && entry.loan.daysPastDue === 0) {
      collected += entry.loan.monthlyPayment;
    } else {
      missed.push({
        contractId: entry.loan.contractId,
        amount: entry.loan.monthlyPayment,
        accountStatus: entry.loan.accountStatus,
        daysPastDue: entry.loan.daysPastDue,
      });
    }
  }
  return { totalMonthlyDue, collected, missed };
}
