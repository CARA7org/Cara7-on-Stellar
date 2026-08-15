"use client";

import type { ReactNode } from "react";
import { useLocale } from "@/lib/i18n";
import { fmtDate } from "@/lib/reportFormat";
import type { MonthlyReport } from "@/data/report";

/** Deal name + subtitle on the left, cut-off / payment dates on the right. */
export function ReportHeader({ report }: { report: MonthlyReport }): ReactNode {
  const { locale, dictionary } = useLocale();

  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-medium">{report.dealName}</h1>
        <p className="mt-0.5 text-[13px] text-gray-600 dark:text-gray-400">
          {report.subtitle[locale]}
        </p>
      </div>
      <div className="text-right text-xs text-gray-600 dark:text-gray-400">
        <div>
          {dictionary.cutoffDate} {fmtDate(locale, report.cutoffDate)}
        </div>
        <div>
          {dictionary.paymentDate} {fmtDate(locale, report.paymentDate)}
        </div>
      </div>
    </div>
  );
}
