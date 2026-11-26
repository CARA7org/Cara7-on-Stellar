"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { TxFeedback } from "@/components/TxFeedback";
import { refreshNoteDataAfterTx } from "@/hooks/useNoteData";
import { txErrorText, type TxStatus } from "@/hooks/useTxRunner";
import { useLocale } from "@/lib/i18n";
import {
  clearPendingHandle,
  handleDeadlineMs,
  isWaitActive,
  onPendingHandleChange,
  readPendingHandle,
  type PendingHandle,
} from "@/services/pendingHandle";
import { resumePendingAction } from "@/services/resumeApproval";
import { explorerTxUrl } from "@/services/trancheTx";
import useStellarWalletStore from "@/stores/useStellarWalletStore";

/**
 * A banner on every page while a Dfns action waits for a policy approval.
 * When a Dfns wallet connects (also after a reload) and a saved handle has
 * the same address, the banner resumes the wait. It then shows the result
 * of the resumed action until the user closes it.
 */
export default function PendingApprovalBanner() {
  const { dictionary } = useLocale();
  const provider = useStellarWalletStore((s) => s.provider);
  const address = useStellarWalletStore((s) => s.address);
  const [handle, setHandle] = useState<PendingHandle | null>(null);
  const [result, setResult] = useState<TxStatus>(null);

  // Follow the saved handle (save, approval id, removal).
  useEffect(() => {
    const sync = () => setHandle(readPendingHandle());
    sync();
    return onPendingHandleChange(sync);
  }, []);

  // Resume the wait when a Dfns wallet with the same address connects.
  useEffect(() => {
    if (provider !== "dfns" || !address) return;
    const saved = readPendingHandle();
    if (!saved || saved.address !== address || isWaitActive(saved.requestId)) return;
    if (handleDeadlineMs(saved.maxTime) <= Date.now()) {
      clearPendingHandle(saved.requestId);
      setResult({ kind: "error", message: dictionary.txApprovalExpired });
      return;
    }
    setResult(null);
    resumePendingAction(saved)
      .then(({ hash }) => {
        setResult({ kind: "success", hash });
        refreshNoteDataAfterTx();
      })
      .catch((e: unknown) => setResult({ kind: "error", message: txErrorText(e, dictionary) }));
  }, [provider, address, dictionary]);

  const waiting = handle !== null && provider === "dfns" && handle.address === address;
  if (!waiting && !result) return null;

  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs dark:border-amber-800/60 dark:bg-amber-950/30">
      {waiting ? (
        <p className="break-words text-amber-800 dark:text-amber-300">
          {dictionary.pendingBannerTitle}
          {handle.approvalId && (
            <>
              {": "}
              <span className="font-mono break-all">{handle.approvalId}</span>
            </>
          )}
          . {dictionary.txApproverDecides}
        </p>
      ) : result?.kind === "success" ? (
        <p className="flex-1 break-words text-green-700 dark:text-green-400">
          {dictionary.txConfirmed}{" "}
          <a
            href={explorerTxUrl(result.hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono break-all underline"
          >
            {result.hash}
          </a>
        </p>
      ) : (
        <div className="flex-1 [&>p]:mb-0">
          <TxFeedback status={result} />
        </div>
      )}
      {!waiting && (
        <button
          onClick={() => setResult(null)}
          className="p-0.5 rounded transition-colors"
          aria-label={dictionary.close}
          title={dictionary.close}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
