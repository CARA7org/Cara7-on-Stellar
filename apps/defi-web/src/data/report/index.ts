import type { MonthlyReport } from "./types";
import { REPORT_2026_01_31 } from "./2026-01-31";

/** All published monthly reports, keyed by cut-off date. */
export const REPORTS: Record<string, MonthlyReport> = {
  "2026-01-31": REPORT_2026_01_31,
};

/** The report the home page renders. */
export const LATEST_REPORT: MonthlyReport = REPORT_2026_01_31;

export type {
  DelinquencyBucket,
  DelinquencyBucketId,
  LocalizedText,
  LossCushion,
  MonthlyLossPoint,
  MonthlyReport,
  PoolTile,
  ReportTranche,
  TrancheRateTerms,
} from "./types";
