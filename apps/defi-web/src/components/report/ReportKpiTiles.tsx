"use client";

import type { ReactNode } from "react";
import { useLocale } from "@/lib/i18n";
import { fmtMillions, fmtPct } from "@/lib/reportFormat";
import type { MonthlyReport } from "@/data/report";

function KpiTile({
  label,
  value,
  hint,
  hintTone = "muted",
}: {
  label: string;
  value: string;
  hint: string;
  hintTone?: "muted" | "positive";
}): ReactNode {
  return (
    <div className="rounded bg-gray-100 p-4 dark:bg-neutral-800/60">
      <div className="text-[13px] text-gray-600 dark:text-gray-400">{label}</div>
      <div className="mt-1 text-2xl font-medium">{value}</div>
      <div
        className={`mt-0.5 text-xs ${
          hintTone === "positive"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-gray-600 dark:text-gray-400"
        }`}
      >
        {hint}
      </div>
    </div>
  );
}

/** The four headline tiles: portfolio, notes, reserve fund, net loss ratio. */
export function ReportKpiTiles({ report }: { report: MonthlyReport }): ReactNode {
  const { locale, dictionary } = useLocale();
  const { portfolio } = report;

  return (
    <div className="mb-7 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
      <KpiTile
        label={dictionary.kpiPortfolioOutstanding}
        value={fmtMillions(locale, portfolio.outstandingEur)}
        hint={dictionary.momHint(fmtPct(locale, portfolio.momChangePct, 2))}
      />
      <KpiTile
        label={dictionary.kpiNotesOutstanding}
        value={fmtMillions(locale, portfolio.notesOutstandingEur)}
        hint={dictionary.initialIssuanceHint(
          fmtMillions(locale, portfolio.initialIssuanceEur)
        )}
      />
      <KpiTile
        label={dictionary.kpiCashReserve}
        value={fmtMillions(locale, portfolio.reserveFundEur)}
        hint={dictionary.reserveRequiredHint(
          fmtPct(locale, portfolio.reserveFundPctOfRequired, 0)
        )}
        hintTone="positive"
      />
      <KpiTile
        label={dictionary.kpiNetLossMonth}
        value={fmtPct(locale, portfolio.netLossMonthPct, 2)}
        hint={dictionary.rollingAvgHint(
          fmtPct(locale, portfolio.netLossRolling3mPct, 2)
        )}
      />
    </div>
  );
}
