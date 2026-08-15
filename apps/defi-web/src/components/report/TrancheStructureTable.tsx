"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useLocale, type Dictionary, type Locale } from "@/lib/i18n";
import { fmtMillions, fmtPct } from "@/lib/reportFormat";
import { SENIORITY_COLOR } from "@/lib/seniority";
import type { MonthlyReport, TrancheRateTerms } from "@/data/report";
import type { TrancheInfo } from "@/services/registry";

function rateText(
  dictionary: Dictionary,
  locale: Locale,
  rate: TrancheRateTerms
): string {
  if (rate.kind === "floating") {
    return dictionary.rateFloating(
      fmtPct(locale, rate.spreadPct, 2),
      fmtPct(locale, rate.floorPct, 0)
    );
  }
  return dictionary.rateFixed(fmtPct(locale, rate.ratePct, 2));
}

/**
 * The Class A/B/C table of the report. Rows come from the static dataset;
 * when a live registry tranche with the same seniority exists, the class
 * cell links to its /tranches/{id} page.
 */
export function TrancheStructureTable({
  report,
  liveTranches,
}: {
  report: MonthlyReport;
  liveTranches: TrancheInfo[] | null;
}): ReactNode {
  const { locale, dictionary } = useLocale();
  const liveBySeniority = new Map(
    (liveTranches ?? []).map((tranche) => [tranche.seniority, tranche])
  );
  const head = "px-1 py-1.5 font-medium text-gray-600 dark:text-gray-400";
  const cell = "px-1 py-2";

  return (
    <section className="mb-7">
      <h2 className="mb-3 text-sm font-medium">{dictionary.trancheStructure}</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] table-fixed border-collapse text-[13px]">
          <colgroup>
            <col style={{ width: "16%" }} />
            <col style={{ width: "20%" }} />
            <col style={{ width: "20%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "11%" }} />
          </colgroup>
          <thead>
            <tr className="border-b border-gray-300 dark:border-neutral-700">
              <th className={`${head} text-left`}>{dictionary.headClass}</th>
              <th className={`${head} text-right`}>{dictionary.headInitialBalance}</th>
              <th className={`${head} text-right`}>{dictionary.headCurrentBalance}</th>
              <th className={`${head} text-left`}>{dictionary.headRate}</th>
              <th className={`${head} text-right`}>{dictionary.headCreditEnhancement}</th>
              <th className={`${head} text-right`}>{dictionary.headFactor}</th>
            </tr>
          </thead>
          <tbody>
            {report.tranches.map((row) => {
              const live = liveBySeniority.get(row.seniority);
              const classCell = (
                <>
                  {/* class color square - app seniority palette, not the
                      mockup's orange/amber pair (poor separability) */}
                  <span
                    className="mr-1.5 inline-block h-2 w-2 rounded-sm align-baseline"
                    style={{ backgroundColor: SENIORITY_COLOR[row.seniority] }}
                  />
                  {row.label}
                </>
              );
              return (
                <tr
                  key={row.classLetter}
                  className="border-b border-gray-200 dark:border-neutral-800"
                >
                  <td className={cell}>
                    {live ? (
                      <Link href={`/tranches/${live.id}`} className="hover:underline">
                        {classCell}
                      </Link>
                    ) : (
                      classCell
                    )}
                  </td>
                  <td className={`${cell} text-right`}>
                    {fmtMillions(locale, row.initialBalanceEur)}
                  </td>
                  <td className={`${cell} text-right`}>
                    {fmtMillions(locale, row.currentBalanceEur)}
                  </td>
                  <td className={cell}>{rateText(dictionary, locale, row.rate)}</td>
                  <td className={`${cell} text-right`}>
                    {fmtPct(locale, row.creditEnhancementPct, 1)}
                  </td>
                  <td className={`${cell} text-right`}>
                    {fmtPct(
                      locale,
                      row.factorPct,
                      Number.isInteger(row.factorPct) ? 0 : 1
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
