"use client";

import type { ReactNode } from "react";
import { useLocale } from "@/lib/i18n";
import { fmtEur, fmtMillions, fmtPct } from "@/lib/reportFormat";
import { ASSUMED_DEFAULT_RATE_PCT } from "@/lib/rates";
import { SENIORITY_COLOR } from "@/lib/seniority";
import type { MonthlyReport } from "@/data/report";

/**
 * One bar per class (first-loss C first): how much of the loss cushion
 * protecting the class has been consumed by cumulative net losses.
 */
export function LossCushionBars({ report }: { report: MonthlyReport }): ReactNode {
  const { locale, dictionary } = useLocale();

  return (
    <section className="mb-9">
      <h2 className="mb-3 text-sm font-medium">{dictionary.cushionTitle}</h2>
      <div className="flex flex-col gap-2.5">
        {report.lossCushions.map((cushion) => {
          // clamp [2, 100] so a sliver of consumption is still visible
          const usedPct = Math.min(
            100,
            Math.max(2, (cushion.usedEur / cushion.totalEur) * 100)
          );
          return (
            <div key={cushion.classLetter}>
              <div className="mb-1 flex justify-between gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span>
                  {dictionary.cushionLabel(
                    cushion.classLetter,
                    fmtPct(locale, cushion.creditEnhancementPct, 1),
                    cushion.reserveOnly
                  )}
                </span>
                <span>
                  {dictionary.cushionUsage(
                    fmtEur(locale, cushion.usedEur),
                    fmtMillions(locale, cushion.totalEur)
                  )}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-gray-200 dark:bg-neutral-800">
                <div
                  className="h-full"
                  style={{
                    width: `${usedPct}%`,
                    backgroundColor: SENIORITY_COLOR[cushion.seniority],
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {/* The junior class absorbs pool defaults first - show the assumed
          default rate the cushions are read against (display-only). */}
      <p className="mt-3 text-xs text-gray-600 dark:text-gray-400">
        {dictionary.cushionDefaultAssumption(
          fmtPct(locale, ASSUMED_DEFAULT_RATE_PCT, 2),
          fmtMillions(
            locale,
            (report.portfolio.initialIssuanceEur * ASSUMED_DEFAULT_RATE_PCT) / 100
          )
        )}
      </p>
    </section>
  );
}
