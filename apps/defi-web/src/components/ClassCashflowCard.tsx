"use client";

import { useEffect, useState } from "react";
import { fetchDistributions, type Distribution } from "@/services/registry";
import type { TrancheStats } from "@/services/indexer";
import { formatAmount } from "@/lib/format";
import { useLocale } from "@/lib/i18n";

/**
 * Cash flows of one note class through the waterfall: the last executed
 * period (interest / principal / shortfall for this class), the cumulative
 * amounts paid to date, and the deal-level reserve and rounding carry after
 * the last period.
 */
export function ClassCashflowCard({
  dealId,
  trancheContractId,
  classIndex,
  stats,
  symbol,
  decimals,
}: {
  dealId: number;
  trancheContractId: string;
  classIndex: number;
  stats: TrancheStats | null;
  symbol: string;
  decimals: number;
}) {
  const { dictionary } = useLocale();
  const [latest, setLatest] = useState<Distribution | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { distributions } = await fetchDistributions(dealId);
      if (!active) return;
      setLatest(distributions[0] ?? null);
      setLoaded(true);
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [dealId]);

  const entry =
    latest?.perClass.find((candidate) => candidate.tranche === trancheContractId) ??
    latest?.perClass.find((candidate) => candidate.class === classIndex) ??
    null;

  const row = (label: string, value: string) => (
    <div className="flex justify-between">
      <span className="text-gray-600 dark:text-gray-400">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );

  return (
    <div className="rounded border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-lg font-semibold">{dictionary.cashflowTitle}</h3>
        <span className="text-xs text-gray-500">
          {latest
            ? dictionary.cashflowLastPeriod(latest.period)
            : dictionary.cashflowPriorityTag}
        </span>
      </div>

      {!loaded && <p className="mt-3 text-sm text-gray-500">{dictionary.loading}</p>}
      {loaded && !latest && (
        <p className="mt-3 text-sm text-gray-500">{dictionary.cashflowNoPeriod}</p>
      )}

      {latest && (
        <div className="mt-3 flex flex-col gap-1.5 text-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            {dictionary.cashflowLastDistribution}
          </p>
          {row(
            dictionary.cashflowInterest,
            `${formatAmount(entry?.interest ?? "0", decimals)} ${symbol}`
          )}
          {row(
            dictionary.cashflowPrincipal,
            `${formatAmount(entry?.principal ?? "0", decimals)} ${symbol}`
          )}
          {row(
            dictionary.cashflowShortfall,
            `${formatAmount(entry?.shortfall ?? "0", decimals)} ${symbol}`
          )}
        </div>
      )}

      {stats && (
        <div className="mt-4 flex flex-col gap-1.5 border-t border-gray-200 dark:border-neutral-800 pt-3 text-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            {dictionary.cashflowCumulative}
          </p>
          {row(
            dictionary.cashflowInterestPaid,
            `${formatAmount(stats.cumulative.interestPaid, decimals)} ${symbol}`
          )}
          {row(
            dictionary.cashflowPrincipalRepaid,
            `${formatAmount(stats.cumulative.principalPaid, decimals)} ${symbol}`
          )}
        </div>
      )}

      {latest && (
        <div className="mt-4 flex flex-col gap-1.5 border-t border-gray-200 dark:border-neutral-800 pt-3 text-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            {dictionary.cashflowDealAfter}
          </p>
          {row(
            dictionary.cashflowReserve,
            `${formatAmount(latest.reserveRefunded, decimals)} ${symbol}`
          )}
          {row(
            dictionary.cashflowCarry,
            `${formatAmount(latest.carryOut, decimals)} ${symbol}`
          )}
        </div>
      )}
    </div>
  );
}
