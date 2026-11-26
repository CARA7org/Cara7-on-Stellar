"use client";

import { useLocale } from "@/lib/i18n";
import { explorerTxUrl } from "@/services/trancheTx";
import type { TxStatus } from "@/hooks/useTxRunner";

/* ── tx feedback line (shared by every form action) ── */
export function TxFeedback({ status }: { status: TxStatus }) {
  const { dictionary } = useLocale();
  if (!status) return null;

  if (status.kind === "awaiting") {
    return (
      <p className="mb-2 text-xs break-words text-amber-700 dark:text-amber-400">
        {dictionary.txAwaitingApproval}{" "}
        {status.approvalId && (
          <>
            {dictionary.txApprovalIdLabel}{" "}
            <span className="font-mono break-all">{status.approvalId}</span>.{" "}
          </>
        )}
        {dictionary.txApproverDecides}
      </p>
    );
  }

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
