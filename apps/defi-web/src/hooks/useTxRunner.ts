"use client";

import { useState } from "react";
import { useLocale, type Dictionary } from "@/lib/i18n";
import { SignerError, type TxOptions } from "@/services/signers/types";
import {
  ContractCallError,
  DEAL_ERROR_NOT_ELIGIBLE,
  NOTE_ERROR_RECEIVER_NOT_ELIGIBLE,
} from "@/services/trancheTx";

/** The feedback line of a signed action. */
export type TxStatus =
  | { kind: "success"; hash: string }
  | { kind: "awaiting"; approvalId: string | null }
  | { kind: "error"; message: string }
  | null;

/** A readable error in the user's language. A signer error has a known kind. */
export function txErrorText(e: unknown, dictionary: Dictionary): string {
  if (e instanceof SignerError) {
    const reason = e.reason ?? "";
    switch (e.kind) {
      case "denied":
        return dictionary.txApprovalDenied(reason);
      case "blocked":
        return dictionary.txPolicyBlocked(reason);
      case "failed":
        return dictionary.txSigningFailed(reason);
      case "expired":
        return dictionary.txApprovalExpired;
      case "changed":
        return dictionary.txBodyChanged;
    }
  }
  // A whitelist error of a new deal. Each code has this meaning only on its
  // own contract: the deal (subscribe, cancel) or a note token (transfer).
  if (e instanceof ContractCallError) {
    const dealCall = e.method === "subscribe" || e.method === "cancel";
    if (dealCall && e.code === DEAL_ERROR_NOT_ELIGIBLE) return dictionary.notWhitelisted;
    if (e.method === "transfer" && e.code === NOTE_ERROR_RECEIVER_NOT_ELIGIBLE) {
      return dictionary.receiverNotWhitelisted;
    }
  }
  return e instanceof Error ? e.message : dictionary.txFailed;
}

/**
 * Runs one signed action at a time. While a policy approval is pending, the
 * status has the kind "awaiting" with the approval id.
 */
export function useTxRunner() {
  const { dictionary } = useLocale();
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<TxStatus>(null);

  const run = async (
    action: (options: TxOptions) => Promise<{ hash: string }>
  ): Promise<boolean> => {
    setSubmitting(true);
    setStatus(null);
    try {
      const { hash } = await action({
        onAwaitingApproval: (info) =>
          setStatus({ kind: "awaiting", approvalId: info.approvalId }),
      });
      setStatus({ kind: "success", hash });
      return true;
    } catch (e) {
      setStatus({ kind: "error", message: txErrorText(e, dictionary) });
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const awaiting = submitting && status?.kind === "awaiting";
  /** The label of a busy action button. */
  const busyLabel = awaiting ? dictionary.awaitingApproval : dictionary.confirmInWallet;

  return { submitting, status, awaiting, busyLabel, run };
}
