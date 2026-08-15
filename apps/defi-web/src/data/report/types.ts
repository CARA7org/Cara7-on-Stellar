import type { Seniority } from "@/lib/seniority";

/**
 * Shape of a static monthly investor report (IQ EQ figures, one file per
 * cut-off date). Raw numbers only - formatting is applied at render time by
 * lib/reportFormat.ts; deal-specific prose is stored in both languages.
 */

/** Deal-specific prose, written out in both report languages. */
export interface LocalizedText {
  en: string;
  fr: string;
}

/** Contractual rate terms as printed in the prospectus. */
export type TrancheRateTerms =
  | { kind: "floating"; index: "E1M"; spreadPct: number; floorPct: number }
  | { kind: "fixed"; ratePct: number };

export interface ReportTranche {
  classLetter: "A" | "B" | "C";
  /** Row label, identical in both languages ("A · Senior"). */
  label: string;
  /** Join key to the live registry tranches and the app color system. */
  seniority: Seniority;
  initialBalanceEur: number;
  currentBalanceEur: number;
  rate: TrancheRateTerms;
  creditEnhancementPct: number;
  factorPct: number;
}

export interface MonthlyLossPoint {
  /** "YYYY-MM". */
  month: string;
  lossEur: number;
}

export type DelinquencyBucketId = "31-60" | "61-90" | ">90";

export interface DelinquencyBucket {
  bucket: DelinquencyBucketId;
  pctOfPortfolio: number;
  contracts: number;
}

export interface LossCushion {
  classLetter: "A" | "B" | "C";
  seniority: Seniority;
  creditEnhancementPct: number;
  /** Class C is protected by the cash reserve only. */
  reserveOnly: boolean;
  usedEur: number;
  totalEur: number;
}

export interface PoolTile {
  label: LocalizedText;
  /** Displayed as-is ("61", "~88%*", "IPFS") - not locale-formatted. */
  value: string;
  detail: LocalizedText;
  /** Optional external links (explorer contract pages...) shown under the detail. */
  links?: { label: string; url: string }[];
}

export interface AgentChip {
  /** Folder name under apps/spv-backend/src/agents/ - keys agent-reports.ts. */
  slug: string;
  name: LocalizedText;
}

export interface MonthlyReport {
  /** ISO cut-off date - also the report key in the REPORTS record. */
  cutoffDate: string;
  paymentDate: string;
  dealName: string;
  subtitle: LocalizedText;
  /** Screen-reader description of the whole report page. */
  srDescription: LocalizedText;
  statusBadges: LocalizedText[];
  portfolio: {
    outstandingEur: number;
    momChangePct: number;
    notesOutstandingEur: number;
    initialIssuanceEur: number;
    reserveFundEur: number;
    reserveFundPctOfRequired: number;
    netLossMonthPct: number;
    netLossRolling3mPct: number;
  };
  tranches: ReportTranche[];
  monthlyLosses: MonthlyLossPoint[];
  cumulativeLosses: {
    totalEur: number;
    pctOfInitialPortfolio: number;
    pctOfReserveFund: number;
  };
  delinquency: {
    buckets: DelinquencyBucket[];
    totalPct: number;
    totalContracts: number;
  };
  /** Ordered as displayed: first-loss C first, then B, then A. */
  lossCushions: LossCushion[];
  onchain: {
    note: LocalizedText;
    distributionsCaveat: LocalizedText;
    poolTiles: PoolTile[];
    agents: AgentChip[];
  };
}
