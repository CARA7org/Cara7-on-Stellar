"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Input } from "@/components/ui/input";
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import {
  useTrancheStats,
  useNotePosition,
  refreshNoteDataAfterTx,
} from "@/hooks/useNoteData";
import { formatAmount, formatQty, fromBaseUnits } from "@/lib/format";
import { TrancheChart } from "@/components/TrancheChart";
import { UserPositionChart } from "@/components/UserPositionChart";
import { ClassCashflowCard } from "@/components/ClassCashflowCard";
import { AuditTrail } from "@/components/AuditTrail";
import type { TrancheStats, NotePosition } from "@/services/indexer";
import {
  fetchTranche,
  fetchDeals,
  type TrancheDetail,
  type DealInfo,
} from "@/services/registry";
import {
  fetchSubscription,
  fetchClaimable,
  fetchFundingProgress,
  seniorityIndex,
  type FundingProgress,
} from "@/services/waterfall";
import { trancheRate, ASSUMED_DEFAULT_RATE_PCT } from "@/lib/rates";
import { useLocale } from "@/lib/i18n";
import { fmtDate } from "@/lib/reportFormat";
import {
  invokeDeal,
  claimHeldPayments,
  fetchTokenBalance,
  explorerTxUrl,
} from "@/services/trancheTx";

type ContentTab = "TranchePerformance" | "YourPosition";

/** One note = 100 EURC at par (the deal's note_denomination). */
const NOTE_DENOMINATION = 100;

const CLASS_LETTER: Record<TrancheDetail["seniority"], string> = {
  SENIOR: "A",
  MEZZANINE: "B",
  JUNIOR: "C",
};

/**
 * Display phase of the class: the deal lifecycle, except a fully repaid
 * class (note factor 0 after closing) which shows as REDEEMED.
 */
function classPhase(deal: DealInfo | null, stats: TrancheStats | null): string {
  const basePhase = deal?.phase ?? stats?.phase ?? "FUNDING";
  if (
    basePhase !== "FUNDING" &&
    (stats?.phase === "REDEEMED" || (stats != null && stats.noteFactorPct === 0 && stats.ts != null))
  ) {
    return "REDEEMED";
  }
  return basePhase;
}

/* ── Stat card (mockup style: uppercase label, big value, delta line) ── */
function StatCard({
  label,
  value,
  suffix,
  delta,
}: {
  label: string;
  value: string;
  suffix?: string;
  delta?: string;
}) {
  return (
    <div className="flex flex-col flex-1 gap-1 sm:px-4 first:pl-0 last:pr-0 even:border-l even:pl-4 border-gray-300 dark:border-neutral-700">
      <span className="text-xs uppercase tracking-wide text-gray-500">{label}</span>
      <span className="text-2xl font-semibold">
        {value}
        {suffix && (
          <span className="text-sm text-gray-500 ml-1">{suffix}</span>
        )}
      </span>
      {delta && <span className="text-xs text-emerald-600 dark:text-emerald-400">{delta}</span>}
    </div>
  );
}

/* ── Tranche Performance panel ── */
function TranchePerformancePanel({
  tranche,
  stats,
  deal,
}: {
  tranche: TrancheDetail;
  stats: TrancheStats | null;
  deal: DealInfo | null;
}) {
  const symbol = tranche.assetSymbol;
  const decimals = tranche.assetDecimals;
  const { locale, dictionary } = useLocale();
  const funding = classPhase(deal, stats) === "FUNDING";

  const auditContracts = [
    tranche.contractId,
    deal?.dealContractId ?? "",
    deal?.payingAgentContractId ?? "",
  ].filter(Boolean);

  return (
    <div className="flex flex-col w-full gap-6">
      {/* Note economics (prospectus-style: factor, outstanding, rate) */}
      <div className="grid w-full grid-cols-2 gap-4 p-4 rounded sm:flex sm:gap-0 border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        <StatCard
          label={dictionary.tileNoteFactor}
          value={
            stats && !funding ? `${stats.noteFactorPct.toFixed(3)}%` : "-"
          }
          delta={dictionary.tileNoteFactorHint}
        />
        <StatCard
          label={dictionary.tileOutstandingNominal}
          value={stats ? formatAmount(stats.outstanding, decimals) : "-"}
          suffix={symbol}
        />
        <StatCard
          label={dictionary.tileRate}
          value={trancheRate(tranche).allIn}
          delta={dictionary.ratePricingLabel(trancheRate(tranche).pricing)}
        />
        <StatCard label={dictionary.tileSeniority} value={tranche.seniority} />
      </div>

      {/* Amortization row: what the waterfall has paid so far, what is next */}
      <div className="grid w-full grid-cols-2 gap-4 p-4 rounded sm:flex sm:gap-0 border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        <StatCard
          label={dictionary.tilePrincipalRepaid}
          value={stats ? formatAmount(stats.cumulative.principalPaid, decimals) : "-"}
          suffix={symbol}
          delta={dictionary.tilePrincipalRepaidHint}
        />
        <StatCard
          label={dictionary.tileInterestPaid}
          value={stats ? formatAmount(stats.cumulative.interestPaid, decimals) : "-"}
          suffix={symbol}
        />
        <StatCard
          label={dictionary.tileNextPayment}
          value={stats?.nextPayment ? fmtDate(locale, stats.nextPayment.dueAt) : "-"}
          delta={
            stats?.nextPayment
              ? dictionary.tileNextPaymentHint(
                  formatAmount(stats.nextPayment.estimatedInterest, decimals),
                  symbol
                )
              : undefined
          }
        />
        {/* First-loss risk assumption - junior only (Eric, 2026-08-03) */}
        {tranche.seniority === "JUNIOR" && (
          <StatCard
            label={dictionary.tileAssumedDefault}
            value={`${ASSUMED_DEFAULT_RATE_PCT.toFixed(2)}%`}
            delta={dictionary.tileAssumedDefaultHint}
          />
        )}
      </div>

      {/* Outstanding / note-factor chart */}
      <TrancheChart
        contractId={tranche.contractId}
        symbol={symbol}
        decimals={decimals}
      />

      {/* Mockup-inspired panels: class cash flows + on-chain audit trail */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ClassCashflowCard
          dealId={tranche.dealId}
          trancheContractId={tranche.contractId}
          classIndex={seniorityIndex(tranche.seniority)}
          stats={stats}
          symbol={symbol}
          decimals={decimals}
        />
        <AuditTrail
          contractIds={auditContracts}
          symbol={symbol}
          decimals={decimals}
        />
      </div>
    </div>
  );
}

/* ── Position panel ── */
function PositionPanel({
  tranche,
  stats,
  position,
}: {
  tranche: TrancheDetail;
  stats: TrancheStats | null;
  position: NotePosition | null;
}) {
  const symbol = tranche.assetSymbol;
  const decimals = tranche.assetDecimals;
  const { dictionary } = useLocale();

  const units = position ? Number(position.units) : 0;
  const faceValue = units * NOTE_DENOMINATION;
  const outstandingClaim = position
    ? fromBaseUnits(position.outstandingClaim, decimals)
    : 0;
  const interestReceived = position
    ? fromBaseUnits(position.interestReceived, decimals)
    : 0;
  const principalReceived = position
    ? fromBaseUnits(position.principalReceived, decimals)
    : 0;
  const received = interestReceived + principalReceived;
  const subscribed = position ? fromBaseUnits(position.subscribed, decimals) : 0;

  // Simple next-coupon estimate: remaining claim x all-in rate x period/360.
  const nextCoupon =
    stats?.coupon && stats?.accrued && outstandingClaim > 0
      ? (outstandingClaim * (stats.coupon.allInPct / 100) * stats.accrued.periodDays) /
        360
      : null;

  // Total return only means something against a cost basis (funding-window
  // subscriber); a secondary buyer's entry price is unknown to the chain.
  const totalReturn = subscribed > 0 ? outstandingClaim + received - subscribed : null;
  const returnColor =
    (totalReturn ?? 0) >= 0
      ? "text-green-600 dark:text-green-400"
      : "text-red-600 dark:text-red-400";

  return (
    <div className="flex flex-col w-full gap-6">
      <div className="rounded border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
        <h3 className="text-lg font-semibold mb-3">{dictionary.positionTitle}</h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-gray-600 dark:text-gray-400">
              {dictionary.posNotesHeld}
            </span>
            <span>
              {units}
              <span className="ml-2 text-xs text-gray-500">
                {dictionary.posFaceValue(formatQty(faceValue), symbol)}
              </span>
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-gray-600 dark:text-gray-400">
              {dictionary.posOutstandingClaim}
            </span>
            <span>
              {formatQty(outstandingClaim)} {symbol}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-gray-600 dark:text-gray-400">
              {dictionary.posInterestReceived}
            </span>
            <span>
              {formatQty(interestReceived)} {symbol}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-gray-600 dark:text-gray-400">
              {dictionary.posPrincipalReceived}
            </span>
            <span>
              {formatQty(principalReceived)} {symbol}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-gray-600 dark:text-gray-400">
              {dictionary.posNextCoupon}
            </span>
            <span>
              {nextCoupon != null ? `${formatQty(nextCoupon)} ${symbol}` : "-"}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-gray-600 dark:text-gray-400">
              {dictionary.posTotalReturn}
            </span>
            <span className={totalReturn != null ? returnColor : undefined}>
              {totalReturn != null ? `${formatQty(totalReturn)} ${symbol}` : "-"}
            </span>
          </div>
        </div>
      </div>

      <UserPositionChart
        contractId={tranche.contractId}
        symbol={symbol}
        decimals={decimals}
      />
    </div>
  );
}

/* ── tx feedback line (shared by every form action) ── */
type TxStatus =
  | { kind: "success"; hash: string }
  | { kind: "error"; message: string }
  | null;

function TxFeedback({ status }: { status: TxStatus }) {
  const { dictionary } = useLocale();
  if (!status) return null;
  return (
    <p
      className={`mb-2 text-xs break-all ${
        status.kind === "success"
          ? "text-green-600 dark:text-green-400"
          : "text-red-600 dark:text-red-400"
      }`}
    >
      {status.kind === "success" ? (
        <>
          {dictionary.txConfirmed}{" "}
          <a
            href={explorerTxUrl(status.hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {dictionary.viewTransaction}
          </a>
        </>
      ) : (
        status.message
      )}
    </p>
  );
}

const CTA_GRADIENT =
  "w-full rounded-full text-white bg-[linear-gradient(90deg,#04003c_0%,#570a61_55%,#91117e_100%)] disabled:opacity-50";

/* ── Subscription form (phase-driven) ── */
function SubscriptionForm({
  tranche,
  stats,
  position,
  deal,
}: {
  tranche: TrancheDetail;
  stats: TrancheStats | null;
  position: NotePosition | null;
  deal: DealInfo | null;
}) {
  const symbol = tranche.assetSymbol;
  const decimals = tranche.assetDecimals;
  const classIndex = seniorityIndex(tranche.seniority);
  const classLetter = CLASS_LETTER[tranche.seniority];
  const connected = useStellarWalletStore((s) => s.connected);
  const address = useStellarWalletStore((s) => s.address);
  const { locale, dictionary } = useLocale();

  const phase = classPhase(deal, stats);
  const dealContractId = deal?.dealContractId ?? null;
  const payingAgentContractId = deal?.payingAgentContractId ?? null;

  const [formType, setFormType] = useState<"subscribe" | "cancel">("subscribe");
  const [inputAmount, setInputAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [txStatus, setTxStatus] = useState<TxStatus>(null);
  const isSubscribe = formType === "subscribe";

  // book-building progress of the whole class (all subscribers, not just us)
  const [fundingProgress, setFundingProgress] = useState<FundingProgress | null>(null);
  useEffect(() => {
    if (phase !== "FUNDING" || !dealContractId) return;
    let active = true;
    const load = async () => {
      const progress = await fetchFundingProgress(dealContractId);
      if (active) setFundingProgress(progress);
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [phase, dealContractId, txStatus]);

  // wallet balance of the deal asset (subscribe max, refunds landing)
  const [walletBalance, setWalletBalance] = useState(0);
  useEffect(() => {
    if (!address) return;
    let active = true;
    const load = async () => {
      const balance = await fetchTokenBalance(tranche.baseAssetId, address, decimals);
      if (active) setWalletBalance(balance);
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [address, txStatus, tranche.baseAssetId, decimals]);

  // pending funding-window subscription, in whole notes (cancel max)
  const [pendingNotes, setPendingNotes] = useState(0);
  const loadSubscription = useCallback(async () => {
    if (!address || !dealContractId) return;
    const notes = await fetchSubscription(dealContractId, classIndex, address);
    setPendingNotes(notes);
  }, [address, dealContractId, classIndex]);
  useEffect(() => {
    if (phase !== "FUNDING") return;
    loadSubscription();
    const timer = setInterval(loadSubscription, 15_000);
    return () => clearInterval(timer);
  }, [phase, loadSubscription, txStatus]);

  // payments held on the paying agent after a failed push (claim fallback)
  const [claimableEurc, setClaimableEurc] = useState(0);
  useEffect(() => {
    if (!address || !payingAgentContractId || phase === "FUNDING") return;
    let active = true;
    const load = async () => {
      const claimable = await fetchClaimable(payingAgentContractId, classIndex, address);
      if (active) {
        setClaimableEurc(
          Number(claimable.interest + claimable.principal) / 10 ** decimals
        );
      }
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [address, payingAgentContractId, phase, classIndex, decimals, txStatus]);

  const handleConnect = async () => {
    const { StellarWalletsKit } = await import("@creit-tech/stellar-wallets-kit");
    await StellarWalletsKit.authModal();
  };

  const runTx = async (action: () => Promise<{ hash: string }>) => {
    setSubmitting(true);
    setTxStatus(null);
    try {
      const { hash } = await action();
      setTxStatus({ kind: "success", hash });
      // tx -> indexer cron -> API poll takes up to ~45s; burst-refresh so the
      // dashboard picks the new snapshot up as soon as the indexer writes it.
      refreshNoteDataAfterTx();
      return true;
    } catch (e) {
      setTxStatus({
        kind: "error",
        message: e instanceof Error ? e.message : dictionary.txFailed,
      });
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const panelClass =
    "flex flex-col gap-2 w-full max-w-[347px] p-5 pb-8 rounded-[20px] bg-white dark:bg-neutral-900 grow sm:grow-0";

  /* ---- FUNDING: subscribe / cancel at par, whole notes of 100 EURC ---- */
  if (phase === "FUNDING") {
    // Subscriptions settle in whole notes: EURC amounts are multiples of 100.
    const maxAmount = isSubscribe
      ? Math.floor(Math.max(walletBalance, 0) / NOTE_DENOMINATION) * NOTE_DENOMINATION
      : pendingNotes * NOTE_DENOMINATION;

    const amount = Number(inputAmount);
    const notes = Math.round(amount / NOTE_DENOMINATION);
    const canSubmit =
      connected &&
      !submitting &&
      Number.isFinite(amount) &&
      amount > 0 &&
      amount % NOTE_DENOMINATION === 0 &&
      amount <= maxAmount + 1e-9 &&
      dealContractId != null;

    const handleSubmit = async () => {
      if (!address || !canSubmit || !dealContractId) return;
      const done = await runTx(() =>
        invokeDeal(isSubscribe ? "subscribe" : "cancel", {
          dealContractId,
          caller: address,
          classIndex,
          notes: BigInt(notes),
        })
      );
      if (done) {
        setInputAmount("");
        loadSubscription();
      }
    };

    const classSubscribed = fundingProgress?.subscribedNotes[classIndex] ?? null;
    const classTotal = fundingProgress?.totalNotes[classIndex] ?? null;
    const progressPct =
      classSubscribed != null && classTotal != null && classTotal > 0
        ? Math.min(100, (classSubscribed / classTotal) * 100)
        : null;

    return (
      <div className={panelClass}>
        {/* Book-building progress of this class */}
        {progressPct != null && classSubscribed != null && classTotal != null && (
          <div className="mb-2 flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="uppercase tracking-wide text-gray-500">
                {dictionary.bookBuildingLabel}
              </span>
              <span className="text-gray-600 dark:text-gray-400">
                {dictionary.bookBuildingHint(
                  formatQty(classSubscribed * NOTE_DENOMINATION),
                  formatQty(classTotal * NOTE_DENOMINATION),
                  symbol
                )}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-[#2a3142]">
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,#04003c_0%,#570a61_55%,#91117e_100%)] transition-all duration-700"
                style={{ width: `${Math.max(progressPct, progressPct > 0 ? 2 : 0)}%` }}
              />
            </div>
          </div>
        )}

        {/* Subscribe / Cancel toggle */}
        <div className="flex items-center gap-2 p-1 mb-2 bg-gray-200 dark:bg-[#2a3142] rounded-full">
          <Button
            onClick={() => setFormType("subscribe")}
            className={`flex-1 py-3 px-4 rounded-full text-lg font-medium transition-colors ${
              isSubscribe
                ? "!bg-white shadow-sm !text-gray-900 dark:!bg-[#475569] dark:!text-gray-100"
                : "!bg-transparent !text-gray-500 dark:!text-gray-400"
            }`}
          >
            {dictionary.formSubscribe}
          </Button>
          <Button
            onClick={() => setFormType("cancel")}
            className={`flex-1 py-3 px-4 rounded-full text-lg font-medium transition-colors ${
              !isSubscribe
                ? "!bg-white shadow-sm !text-gray-900 dark:!bg-[#475569] dark:!text-gray-100"
                : "!bg-transparent !text-gray-500 dark:!text-gray-400"
            }`}
          >
            {dictionary.formCancel}
          </Button>
        </div>

        {/* Pending escrowed subscription - always visible once it exists */}
        {connected && pendingNotes > 0 && (
          <div className="mt-2 rounded-lg border border-purple-300/60 dark:border-purple-800/60 bg-purple-50 dark:bg-purple-950/30 px-3 py-2">
            <p className="text-xs font-medium text-purple-900 dark:text-purple-200">
              {dictionary.pendingSubTitle}
            </p>
            <p className="mt-0.5 text-xs text-purple-800/80 dark:text-purple-300/80">
              {dictionary.pendingSubCopy(
                pendingNotes,
                formatQty(pendingNotes * NOTE_DENOMINATION),
                symbol
              )}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-4 mt-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {isSubscribe
              ? dictionary.subscribeCopy(symbol, classLetter)
              : dictionary.cancelCopy}
          </p>

          {/* Input (multiples of 100 EURC = whole notes) */}
          <div className="flex flex-col gap-2">
            {connected && (
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setInputAmount(String(maxAmount))}
                  className="flex items-center gap-1 bg-gray-200 dark:bg-[#2a3142] rounded-sm px-2 py-0.5"
                >
                  <span className="text-xs text-gray-600 dark:text-gray-400">
                    {dictionary.maxHint(formatQty(maxAmount), symbol)}
                  </span>
                </button>
                {!isSubscribe && (
                  <span className="text-xs text-gray-500">
                    {dictionary.pendingNotesHint(pendingNotes)}
                  </span>
                )}
              </div>
            )}

            <div className="flex items-center w-full gap-2">
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-sm font-medium">{symbol}</span>
              </div>
              <Input
                type="number"
                step={NOTE_DENOMINATION}
                min={0}
                className="w-full text-right bg-transparent text-neutral-700 dark:text-neutral-300 font-semibold text-2xl placeholder:text-neutral-500"
                placeholder="0"
                value={inputAmount}
                onChange={(e) => setInputAmount(e.target.value)}
              />
            </div>
            <p className="text-xs text-gray-500 text-right">
              {Number.isFinite(amount) && amount > 0 && amount % NOTE_DENOMINATION === 0
                ? dictionary.notesAtPar(notes)
                : dictionary.multiplesHint(symbol)}
            </p>
          </div>

          {/* Balance row: wallet balance before -> after the pending amount */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">
              {dictionary.balanceLabel}
            </span>
            <span>
              {formatQty(walletBalance)} {" -> "}
              {formatQty(
                walletBalance + (Number(inputAmount) || 0) * (isSubscribe ? -1 : 1)
              )}{" "}
              {symbol}
            </span>
          </div>

          {/* The three-step story of the money */}
          <ol className="flex flex-col gap-1.5 border-t border-gray-200 dark:border-neutral-800 pt-3">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              {dictionary.howItWorksTitle}
            </p>
            {[dictionary.howStep1(symbol), dictionary.howStep2, dictionary.howStep3].map(
              (step, index) => (
                <li key={index} className="flex gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gray-200 dark:bg-[#2a3142] text-[10px] font-semibold text-gray-700 dark:text-gray-300">
                    {index + 1}
                  </span>
                  {step}
                </li>
              )
            )}
          </ol>
        </div>

        {/* Spacer */}
        <div className="grow h-[24px]" />

        <TxFeedback status={txStatus} />

        {/* CTA */}
        {connected ? (
          <Button onClick={handleSubmit} className={CTA_GRADIENT} disabled={!canSubmit}>
            {submitting
              ? dictionary.confirmInWallet
              : isSubscribe
                ? dictionary.confirmSubscription
                : dictionary.confirmCancellation}
          </Button>
        ) : (
          <Button onClick={handleConnect} className={CTA_GRADIENT}>
            {dictionary.connectWalletCta}
          </Button>
        )}
      </div>
    );
  }

  /* ---- REDEEMED: nothing left to pay on this class ---- */
  if (phase === "REDEEMED") {
    return (
      <div className={panelClass}>
        <h3 className="text-lg font-semibold">{dictionary.redeemedTitle}</h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {dictionary.redeemedCopy}
        </p>
      </div>
    );
  }

  /* ---- ENFORCED: accelerated priority of payments ---- */
  if (phase === "ENFORCED") {
    return (
      <div className={panelClass}>
        <h3 className="text-lg font-semibold">{dictionary.enforcedTitle}</h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {dictionary.enforcedCopy}
        </p>
        {connected && address && payingAgentContractId && claimableEurc > 0 && (
          <>
            <div className="grow h-[24px]" />
            <TxFeedback status={txStatus} />
            <Button
              onClick={() =>
                runTx(() =>
                  claimHeldPayments({ payingAgentContractId, holder: address })
                )
              }
              className={CTA_GRADIENT}
              disabled={submitting}
            >
              {submitting
                ? dictionary.confirmInWallet
                : dictionary.claimCta(formatQty(claimableEurc), symbol)}
            </Button>
          </>
        )}
      </div>
    );
  }

  /* ---- AMORTIZING (and MATURED fallback): closed primary market ---- */
  const units = position ? Number(position.units) : 0;

  return (
    <div className={panelClass}>
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{dictionary.closedTitle}</h3>
        {connected && units > 0 && (
          <span className="text-xs text-gray-500">
            {dictionary.notesHeldCount(units)}
          </span>
        )}
      </div>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        {dictionary.closedCopy(
          deal?.closedAt ? fmtDate(locale, deal.closedAt) : null
        )}
      </p>

      {/* Spacer */}
      <div className="grow h-[24px]" />

      <TxFeedback status={txStatus} />

      {connected && address && payingAgentContractId && claimableEurc > 0 && (
        <Button
          onClick={() =>
            runTx(() =>
              claimHeldPayments({ payingAgentContractId, holder: address })
            )
          }
          className={CTA_GRADIENT}
          disabled={submitting}
        >
          {submitting
            ? dictionary.confirmInWallet
            : dictionary.claimCta(formatQty(claimableEurc), symbol)}
        </Button>
      )}
    </div>
  );
}

/* ── Main page ── */
export default function TranchePage(props: {
  params: Promise<{ trancheId: string }>;
}) {
  const params = use(props.params);

  const [tranche, setTranche] = useState<TrancheDetail | null | undefined>(
    undefined
  );
  useEffect(() => {
    let active = true;
    fetchTranche(params.trancheId).then((detail) => {
      if (active) setTranche(detail);
    });
    return () => {
      active = false;
    };
  }, [params.trancheId]);

  // Deal record (phase, contract ids, closing date) - refreshed so the form
  // follows the lifecycle FUNDING -> AMORTIZING -> ENFORCED -> MATURED live.
  const [deal, setDeal] = useState<DealInfo | null>(null);
  const dealId = tranche?.dealId;
  useEffect(() => {
    if (dealId == null) return;
    let active = true;
    const load = async () => {
      const deals = await fetchDeals();
      if (active) setDeal(deals.find((candidate) => candidate.id === dealId) ?? null);
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [dealId]);

  const address = useStellarWalletStore((s) => s.address);
  const { dictionary } = useLocale();
  // Hooks run unconditionally (before any early return) - fall back to "" id.
  const { stats } = useTrancheStats(tranche?.contractId ?? "");
  const position = useNotePosition(tranche?.contractId ?? "", address);

  const [activeTab, setActiveTab] = useState<ContentTab>("TranchePerformance");

  const contentTabs: { value: ContentTab; label: string }[] = [
    { value: "TranchePerformance", label: dictionary.tabTranchePerformance },
    { value: "YourPosition", label: dictionary.tabYourPosition },
  ];

  if (tranche === undefined) {
    return <p className="p-8 text-gray-500">{dictionary.loadingTranche}</p>;
  }
  if (tranche === null) {
    return (
      <div className="p-8 text-center">
        <h1 className="text-2xl font-bold">{dictionary.trancheNotFound}</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-2">
          {dictionary.trancheNotFoundHint(params.trancheId)}
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">
        {tranche.deal.name}
      </p>
      <h1 className="text-2xl font-bold">{tranche.name}</h1>
      {tranche.deal.description && (
        <p className="text-gray-600 dark:text-gray-400 mt-1">{tranche.deal.description}</p>
      )}

      {/* Tabs */}
      <div className="flex mt-4">
        <ToggleGroup
          type="single"
          value={activeTab}
          onValueChange={(value) => value && setActiveTab(value as ContentTab)}
        >
          {contentTabs.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {/* Content + Form */}
      <div className="flex flex-col md:flex-row w-full gap-6 mt-4">
        {activeTab === "TranchePerformance" && (
          <TranchePerformancePanel tranche={tranche} stats={stats} deal={deal} />
        )}
        {activeTab === "YourPosition" && (
          <PositionPanel tranche={tranche} stats={stats} position={position} />
        )}

        <div className="w-full md:max-w-[400px]">
          <SubscriptionForm
            tranche={tranche}
            stats={stats}
            position={position}
            deal={deal}
          />
        </div>
      </div>
    </div>
  );
}
