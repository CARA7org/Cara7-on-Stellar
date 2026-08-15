import type { FastifyInstance } from 'fastify';
import { loadPool } from '../asset-pool/pool.js';

/**
 * The diagram's EUROPEAN DATA WAREHOUSE: loan-level export shaped after the
 * ESMA Annex 5 template (subset of the most telling AUTL fields; the full
 * template has ~100 fields, out of demo scope).
 */
const HEADERS = [
  'AUTL1_UniqueIdentifier',
  'AUTL_ObligorLegalForm',
  'AUTL_OriginationDate',
  'AUTL_MaturityDate',
  'AUTL_OriginalTerm',
  'AUTL_CurrentPrincipalBalance',
  'AUTL_CurrentInterestRate',
  'AUTL_AccountStatus',
  'AUTL_DaysInArrears',
  'AUTL_Manufacturer',
  'AUTL_Model',
  'AUTL55_YearOfRegistration',
  'AUTL_MileageOdometer',
  'AUTL64_UpdatedResidualValue',
];

export async function edwRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reporting/edw-export.csv', async (_request, reply) => {
    const pool = loadPool();
    const rows = pool.vehicles.map((entry) =>
      [
        entry.loan.contractId,
        entry.obligor.legalType,
        entry.loan.originationDate,
        entry.loan.maturityDate,
        entry.loan.originalTermMonths,
        entry.loan.currentPrincipal,
        (entry.loan.interestRateBps / 10000).toFixed(4),
        entry.loan.accountStatus,
        entry.loan.daysPastDue,
        entry.vehicle.manufacturer,
        entry.vehicle.model,
        entry.vehicle.yearOfRegistration,
        entry.vehicle.mileageOdometer,
        entry.vehicle.residualValue,
      ].join(','),
    );
    reply.type('text/csv');
    return [HEADERS.join(','), ...rows].join('\n') + '\n';
  });
}
