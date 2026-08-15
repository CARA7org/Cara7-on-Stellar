"use client";

import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { useLocale } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/reportFormat";
import { formatQty, fromBaseUnits } from "@/lib/format";
import type { Distribution } from "@/services/registry";

const MAX_ROWS = 5;

/**
 * Latest on-chain waterfall distributions, straight from the indexer
 * (newest first). Each row links to the Stellar ledger on stellar.expert.
 * Renders localized loading/empty states so the page stands without a
 * backend.
 */
export function LiveDistributions({
  distributions,
  assetSymbol,
  assetDecimals,
}: {
  distributions: Distribution[] | null;
  assetSymbol: string;
  assetDecimals: number;
}): ReactNode {
  const { locale, dictionary } = useLocale();
  const head = "px-1 py-1 font-medium text-gray-600 dark:text-gray-400";

  return (
    <div className="mb-2">
      <h3 className="mb-1.5 text-[13px] text-gray-600 dark:text-gray-400">
        {dictionary.distributionsTitle}
      </h3>
      {distributions === null && (
        <p className="text-xs text-gray-500">{dictionary.loading}</p>
      )}
      {distributions !== null && distributions.length === 0 && (
        <p className="text-xs text-gray-500">{dictionary.distributionsEmpty}</p>
      )}
      {distributions !== null && distributions.length > 0 && (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-gray-300 dark:border-neutral-700">
              <th className={`${head} text-left`}>{dictionary.headPeriod}</th>
              <th className={`${head} text-right`}>{dictionary.headCollections}</th>
              <th className={`${head} text-right`} title={dictionary.adaHint}>
                {dictionary.headAda}
              </th>
              <th className={`${head} text-right`}>{dictionary.headInterestPaid}</th>
              <th className={`${head} text-right`}>{dictionary.headPrincipalPaid}</th>
              <th className={`${head} text-left`} />
            </tr>
          </thead>
          <tbody>
            {distributions.slice(0, MAX_ROWS).map((distribution) => {
              const ledgerUrl = `https://stellar.expert/explorer/testnet/ledger/${distribution.ledger}`;
              const interestTotal = distribution.perClass.reduce(
                (sum, entry) => sum + fromBaseUnits(entry.interest, assetDecimals),
                0
              );
              const principalTotal = distribution.perClass.reduce(
                (sum, entry) => sum + fromBaseUnits(entry.principal, assetDecimals),
                0
              );
              const interestBreakdown = distribution.perClass
                .map(
                  (entry) =>
                    `${String.fromCharCode(65 + entry.class)} ${formatQty(
                      fromBaseUnits(entry.interest, assetDecimals)
                    )}`
                )
                .join(" · ");
              return (
                <tr
                  key={distribution.ledger}
                  className="border-b border-gray-200 dark:border-neutral-800"
                >
                  <td className="px-1 py-1.5">
                    <span className="font-medium">
                      {dictionary.periodLabel(distribution.period)}
                    </span>
                    <span className="ml-1.5 text-gray-500">
                      {fmtDateTime(locale, distribution.ts)}
                    </span>
                  </td>
                  <td className="px-1 py-1.5 text-right">
                    {formatQty(fromBaseUnits(distribution.collections, assetDecimals), 0)}{" "}
                    {assetSymbol}
                  </td>
                  <td className="px-1 py-1.5 text-right" title={dictionary.adaHint}>
                    {formatQty(fromBaseUnits(distribution.ada, assetDecimals), 0)}{" "}
                    {assetSymbol}
                  </td>
                  <td className="px-1 py-1.5 text-right">
                    <span>
                      {formatQty(interestTotal)} {assetSymbol}
                    </span>
                    <span className="block text-[10px] text-gray-500">
                      {interestBreakdown}
                    </span>
                  </td>
                  <td className="px-1 py-1.5 text-right">
                    {formatQty(principalTotal)} {assetSymbol}
                  </td>
                  <td className="px-1 py-1.5 text-right">
                    <a
                      href={ledgerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[var(--report-accent)] hover:underline"
                      title={`Ledger #${distribution.ledger}`}
                    >
                      {dictionary.view}
                      <ExternalLink size={12} aria-hidden />
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
