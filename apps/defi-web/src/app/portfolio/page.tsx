"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { fetchTranches, type TrancheInfo } from "@/services/registry";
import { fetchUserPositions, type NotePosition } from "@/services/indexer";
import { formatQty, fromBaseUnits } from "@/lib/format";
import { SENIORITY_BADGE, SeniorityDot } from "@/lib/seniority";
import { trancheRate } from "@/lib/rates";
import { useLocale } from "@/lib/i18n";

/**
 * "My portfolio" page from the CARA7 dashboard mockup: KPI tiles + the note
 * holdings table (tranche, token, notes held, note factor, outstanding
 * claim, cash received, rate, status) for the connected wallet. A funding
 * subscription shows as a pending row until the closing DvP issues the notes.
 */
function abbreviate(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function tokenCode(tranche: TrancheInfo): string {
  const dealInitials = tranche.dealName
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 4);
  const suffix = { SENIOR: "SEN", MEZZANINE: "MEZ", JUNIOR: "JUN" }[tranche.seniority];
  return `${dealInitials}-${suffix}`;
}

interface Holding {
  tranche: TrancheInfo;
  units: number; // whole notes
  outstandingClaim: number;
  interestReceived: number;
  principalReceived: number;
  subscribed: number; // pending funding-window subscription, asset units
  phase: string;
}

export default function PortfolioPage() {
  const address = useStellarWalletStore((s) => s.address);
  const connected = useStellarWalletStore((s) => s.connected);
  const { dictionary } = useLocale();
  const [holdings, setHoldings] = useState<Holding[] | null>(null);

  useEffect(() => {
    if (!address) {
      setHoldings(null);
      return;
    }
    let active = true;
    const load = async () => {
      const [tranches, positions] = await Promise.all([
        fetchTranches(),
        fetchUserPositions(address),
      ]);
      if (!active) return;
      const byNote = new Map<string, NotePosition>(
        positions.map((position) => [position.tranche, position])
      );
      const rows = tranches.map((tranche) => {
        const position = byNote.get(tranche.contractId);
        const decimals = tranche.assetDecimals;
        return {
          tranche,
          units: position ? Number(position.units) : 0,
          outstandingClaim: position
            ? fromBaseUnits(position.outstandingClaim, decimals)
            : 0,
          interestReceived: position
            ? fromBaseUnits(position.interestReceived, decimals)
            : 0,
          principalReceived: position
            ? fromBaseUnits(position.principalReceived, decimals)
            : 0,
          subscribed: position ? fromBaseUnits(position.subscribed, decimals) : 0,
          phase: tranche.stats?.phase ?? "FUNDING",
        };
      });
      setHoldings(rows);
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [address]);

  // A row matters when notes are held, cash was received, or a funding
  // subscription is pending closing.
  const held = (holdings ?? []).filter(
    (holding) =>
      holding.units > 0 ||
      holding.interestReceived + holding.principalReceived > 0 ||
      (holding.phase === "FUNDING" && holding.subscribed > 0)
  );
  const totalClaim = held.reduce((sum, holding) => sum + holding.outstandingClaim, 0);
  const totalReceived = held.reduce(
    (sum, holding) => sum + holding.interestReceived + holding.principalReceived,
    0
  );
  const weightedCoupon =
    totalClaim > 0
      ? held.reduce(
          (sum, holding) =>
            sum +
            (holding.tranche.stats?.coupon?.allInPct ??
              holding.tranche.couponBps / 100) *
              (holding.outstandingClaim / totalClaim),
          0
        )
      : null;
  const symbol = holdings?.[0]?.tranche.assetSymbol ?? "EURC";

  if (!connected || !address) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <h1 className="text-2xl font-bold">{dictionary.portfolioTitle}</h1>
        <p className="text-gray-600 dark:text-gray-400">
          {dictionary.portfolioConnectPrompt}
        </p>
        <Link href="/" className="text-sm text-[#91117e] dark:text-[#c94fb4] underline">
          {dictionary.browseMarketplace}
        </Link>
      </div>
    );
  }

  const statusPill = (holding: Holding) => {
    if (holding.phase === "FUNDING") {
      return (
        <div className="flex flex-col items-end gap-0.5">
          <span className="rounded-full border border-sky-300 dark:border-sky-800 bg-sky-100 dark:bg-sky-950 px-2 py-0.5 text-xs font-medium text-sky-700 dark:text-sky-300">
            {dictionary.statusFunding}
          </span>
          {holding.subscribed > 0 && (
            <span className="text-[11px] text-gray-500">
              {dictionary.fundingPillHint(
                formatQty(holding.subscribed),
                holding.tranche.assetSymbol
              )}
            </span>
          )}
        </div>
      );
    }
    if (holding.phase === "REDEEMED") {
      return (
        <span className="rounded-full border border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-400">
          {dictionary.statusRedeemed}
        </span>
      );
    }
    if (holding.phase === "ENFORCED") {
      return (
        <span className="rounded-full border border-red-300 dark:border-red-800 bg-red-100 dark:bg-red-950 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
          {dictionary.statusEnforced}
        </span>
      );
    }
    if (holding.phase === "MATURED") {
      return (
        <span className="rounded-full border border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-400">
          {dictionary.statusMatured}
        </span>
      );
    }
    return (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${SENIORITY_BADGE[holding.tranche.seniority]}`}
      >
        {dictionary.statusCurrent}
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-gray-500">
          {dictionary.portfolioKicker}
        </p>
        <h1 className="text-2xl font-bold">{dictionary.portfolioTitle}</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {dictionary.walletLabel}{" "}
          <span className="font-mono">{abbreviate(address)}</span> ·{" "}
          {dictionary.holdingsRefreshHint}
        </p>
      </div>

      {/* KPI tiles */}
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex flex-1 flex-col gap-1 rounded border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <span className="text-xs uppercase tracking-wide text-gray-500">
            {dictionary.kpiOutstandingClaim}
          </span>
          <span className="text-2xl font-semibold">
            {formatQty(totalClaim)}
            <span className="ml-1 text-sm text-gray-500">{symbol}</span>
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-1 rounded border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <span className="text-xs uppercase tracking-wide text-gray-500">
            {dictionary.kpiCashReceived}
          </span>
          <span className="text-2xl font-semibold">
            {formatQty(totalReceived)}
            <span className="ml-1 text-sm text-gray-500">{symbol}</span>
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-1 rounded border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <span className="text-xs uppercase tracking-wide text-gray-500">
            {dictionary.kpiWeightedCoupon}
          </span>
          <span className="text-2xl font-semibold">
            {weightedCoupon != null ? weightedCoupon.toFixed(2) : "-"}
            <span className="ml-1 text-sm text-gray-500">%</span>
          </span>
        </div>
      </div>

      {/* Note holdings table (mockup) */}
      <div className="rounded border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-lg font-semibold">{dictionary.noteHoldingsTitle}</h3>
          <span className="text-xs text-gray-500">
            {dictionary.noteHoldingsSubtitle(symbol)}
          </span>
        </div>
        {holdings === null && (
          <p className="mt-3 text-sm text-gray-500">{dictionary.loadingHoldings}</p>
        )}
        {holdings !== null && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-neutral-800 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-2 pr-3 font-medium">{dictionary.colTranche}</th>
                  <th className="py-2 pr-3 font-medium">{dictionary.colToken}</th>
                  <th className="py-2 pr-3 text-right font-medium">
                    {dictionary.colNotesHeld}
                  </th>
                  <th className="py-2 pr-3 text-right font-medium">
                    {dictionary.colNoteFactor}
                  </th>
                  <th className="py-2 pr-3 text-right font-medium">
                    {dictionary.colOutstandingClaim}
                  </th>
                  <th className="py-2 pr-3 text-right font-medium">
                    {dictionary.colReceived}
                  </th>
                  <th className="py-2 pr-3 text-right font-medium">
                    {dictionary.colRate}
                  </th>
                  <th className="py-2 text-right font-medium">
                    {dictionary.colStatus}
                  </th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((holding) => {
                  const { tranche } = holding;
                  const factorPct =
                    holding.phase !== "FUNDING" && tranche.stats
                      ? tranche.stats.noteFactorPct
                      : null;
                  return (
                    <tr key={tranche.id} className="border-b border-gray-200/60 dark:border-neutral-800/60">
                      <td className="py-2.5 pr-3">
                        <Link
                          href={`/tranches/${tranche.id}`}
                          className="flex items-center gap-2 hover:underline"
                        >
                          <SeniorityDot seniority={tranche.seniority} />
                          {tranche.name}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-xs text-gray-600 dark:text-gray-400">
                        {tokenCode(tranche)}
                      </td>
                      <td className="py-2.5 pr-3 text-right">{holding.units}</td>
                      <td className="py-2.5 pr-3 text-right">
                        {factorPct != null ? `${factorPct.toFixed(3)}%` : "-"}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-medium">
                        {formatQty(holding.outstandingClaim)} {tranche.assetSymbol}
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        <div>
                          {formatQty(
                            holding.interestReceived + holding.principalReceived
                          )}{" "}
                          {tranche.assetSymbol}
                        </div>
                        <div className="text-xs text-gray-500">
                          {dictionary.receivedBreakdown(
                            formatQty(holding.interestReceived),
                            formatQty(holding.principalReceived)
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        <div>{trancheRate(tranche).allIn}</div>
                        <div className="text-xs text-gray-500">
                          {dictionary.ratePricingLabel(trancheRate(tranche).pricing)}
                        </div>
                      </td>
                      <td className="py-2.5 text-right">{statusPill(holding)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
