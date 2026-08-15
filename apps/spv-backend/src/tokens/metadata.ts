import type { Pool, PoolVehicle } from '../asset-pool/pool.js';
import { poolAggregates } from '../asset-pool/pool.js';
import { environment } from '../config.js';

/**
 * Metadata for the diagram's 4 NFT families, ERC-721-like format
 * {name, description, attributes[]}. Attribute names mirror the CARA7
 * scaffold builders (already aligned with ESMA Annex 5 / AUTL prefix):
 * VIN, Manufacturer, Model, Energy, Year, Mileage, Current/Residual Value...
 */
interface Attribute {
  trait_type: string;
  value: string | number;
}

export interface NftMetadata {
  name: string;
  description: string;
  attributes: Attribute[];
  /** Sealed by putMetadata() before storage - never published in clear. */
  confidential?: Record<string, string | number>;
  [key: string]: unknown;
}

export function autoTokenMetadata(entry: PoolVehicle): NftMetadata {
  return {
    name: `Auto Token - ${entry.vehicle.manufacturer} ${entry.vehicle.model}`,
    description: 'TrueABS Auto Token - securitized vehicle collateral (demo pool, Stellar testnet).',
    vin: entry.vin,
    attributes: [
      { trait_type: 'VIN', value: entry.vin },
      { trait_type: 'Manufacturer', value: entry.vehicle.manufacturer },
      { trait_type: 'Model', value: entry.vehicle.model },
      { trait_type: 'Energy', value: entry.vehicle.energy },
      { trait_type: 'Year Of Registration', value: entry.vehicle.yearOfRegistration },
      { trait_type: 'Mileage Odometer (km)', value: entry.vehicle.mileageOdometer },
      { trait_type: 'Original Valuation (EUR)', value: entry.vehicle.originalValuation },
      { trait_type: 'Current Valuation (EUR)', value: entry.vehicle.currentValuation },
      { trait_type: 'Updated Residual Value (EUR)', value: entry.vehicle.residualValue },
      { trait_type: 'Original LTV', value: entry.vehicle.originalLtv },
    ],
  };
}

export function batteryTokenMetadata(entry: PoolVehicle): NftMetadata {
  return {
    name: `Battery Token - ${entry.battery.manufacturer} ${entry.battery.capacityKwh} kWh`,
    description: 'TrueABS Battery Token - battery passport data of the collateral vehicle.',
    vin: entry.vin,
    attributes: [
      { trait_type: 'VIN', value: entry.vin },
      { trait_type: 'Battery Serial', value: entry.battery.serialNumber },
      { trait_type: 'Battery Manufacturer', value: entry.battery.manufacturer },
      { trait_type: 'Chemistry', value: entry.battery.chemistry },
      { trait_type: 'Capacity (kWh)', value: entry.battery.capacityKwh },
      { trait_type: 'State of Health (%)', value: entry.battery.sohPercent },
      { trait_type: 'Charge Cycles', value: entry.battery.chargeCycles },
    ],
  };
}

/**
 * Obligor token: identity and geography stay public; the borrower profile and
 * loan-level performance move into `confidential`, sealed by putMetadata()
 * (AES-256-GCM, see ipfs/encryption.ts). Mirrors the real-world split: pool
 * aggregates are public, loan-level data goes to the authorized data room.
 */
export function obligorTokenMetadata(entry: PoolVehicle): NftMetadata {
  return {
    name: `Obligor Token - ${entry.obligor.obligorId}`,
    description:
      'TrueABS Obligor Token - anonymised obligor of the underlying exposure (no PII; loan-level detail sealed, authorized data room only).',
    vin: entry.vin,
    attributes: [
      { trait_type: 'Obligor ID', value: entry.obligor.obligorId },
      { trait_type: 'Country', value: entry.obligor.country },
      { trait_type: 'Geographic Region', value: entry.obligor.region },
    ],
    confidential: {
      legalType: entry.obligor.legalType,
      employmentStatus: entry.obligor.employmentStatus,
      creditScoreBand: entry.obligor.creditScoreBand,
      contractId: entry.loan.contractId,
      currentPrincipalEur: entry.loan.currentPrincipal,
      interestRateBps: entry.loan.interestRateBps,
      accountStatus: entry.loan.accountStatus,
      daysPastDue: entry.loan.daysPastDue,
    },
  };
}

export interface PoolTokenReferences {
  autoTokenContract: string;
  batteryTokenContract: string;
  obligorTokenContract: string;
  vehicleCids: Record<string, { auto: string; battery: string; obligor: string }>;
}

/// The Pool Token carries the diagram's plug: aggregates + IPFS references
/// of the child tokens + the existing waterfall and tranche contracts.
export function poolTokenMetadata(pool: Pool, references: PoolTokenReferences): NftMetadata {
  return {
    name: `Pool Token - ${pool.dealName}`,
    description:
      'TrueABS Pool Token - aggregate claim on the automobile asset pool, cash flows cascaded by the waterfall smart contract.',
    poolId: pool.poolId,
    cutOffDate: pool.cutOffDate,
    aggregates: poolAggregates(pool),
    dataReferences: references.vehicleCids,
    contracts: {
      autoToken: references.autoTokenContract,
      batteryToken: references.batteryTokenContract,
      obligorToken: references.obligorTokenContract,
      deal: environment.DEAL_CONTRACT_ID,
    },
    attributes: [
      { trait_type: 'Pool ID', value: pool.poolId },
      { trait_type: 'Deal Name', value: pool.dealName },
      { trait_type: 'Vehicle Count', value: pool.vehicles.length },
      { trait_type: 'Cut-Off Date', value: pool.cutOffDate },
    ],
  };
}
