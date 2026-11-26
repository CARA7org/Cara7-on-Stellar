import {
  TransactionBuilder,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { CustodyError } from "../custody";
import {
  beginWait,
  clearPendingHandle,
  endWait,
  handleDeadlineMs,
  savePendingHandle,
  updatePendingApprovalId,
  type PendingKind,
  type SubmitPath,
  type WaitTarget,
} from "../pendingHandle";
import { APPROVAL_EXPIRED, signerErrorOf } from "./dfns";
import {
  SignerError,
  type AwaitingApproval,
  type PendingApproval,
  type TxOptions,
  type WalletSigner,
} from "./types";

const POLL_MS = 3000;

export type SignedTransaction = Transaction | FeeBumpTransaction;
/** Sends a signed transaction and gives its hash (Soroban RPC or Horizon). */
export type SubmitSigned = (signed: SignedTransaction) => Promise<{ hash: string }>;

/** What the page saves when a signature waits for an approval. */
export interface PendingContext {
  kind: PendingKind;
  submitVia: SubmitPath;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls a pending approval every 3 s. It stops on approval (gives the signed
 * XDR), on a denial or a failure (throws), and at the deadline (throws).
 */
async function awaitApproval(
  pending: PendingApproval,
  deadlineMs: number,
  onAwaitingApproval: TxOptions["onAwaitingApproval"]
): Promise<string> {
  const info: AwaitingApproval = {
    approvalId: pending.approvalId,
    requestId: pending.requestId,
  };
  onAwaitingApproval?.({ ...info });
  while (Date.now() < deadlineMs) {
    await sleep(Math.max(0, Math.min(POLL_MS, deadlineMs - Date.now())));
    const state = await pending.poll();
    if (state.status === "approved") return state.signedTxXdr;
    if (state.status !== "pending") throw signerErrorOf(state);
    if (state.approvalId && state.approvalId !== info.approvalId) {
      info.approvalId = state.approvalId;
      onAwaitingApproval?.({ ...info });
    }
  }
  throw new SignerError("expired", APPROVAL_EXPIRED);
}

/**
 * The hash covers the transaction body and not the signatures. An equal
 * hash means that the signer did not change the body.
 */
function assertSameTransaction(preparedHash: string, signed: SignedTransaction): void {
  if (signed.hash().toString("hex") !== preparedHash) {
    throw new SignerError("changed", "The custody provider returned a different transaction.");
  }
}

/** A 401 ends the session but not the request. The handle stays, and a new login resumes the wait. */
function keepsPendingHandle(e: unknown): boolean {
  return e instanceof CustodyError && e.status === 401;
}

/**
 * Waits for the approval of one request, checks the hash, sends the signed
 * transaction, then removes the saved handle. A denial, a failure, an
 * expiry or a send error also removes the handle.
 */
export async function waitAndSubmit(
  target: WaitTarget,
  pending: PendingApproval,
  opts: { networkPassphrase: string } & TxOptions,
  submit: SubmitSigned
): Promise<{ hash: string }> {
  beginWait(target.requestId);
  try {
    const signedTxXdr = await awaitApproval(pending, handleDeadlineMs(target.maxTime), (info) => {
      updatePendingApprovalId(target.requestId, info.approvalId);
      opts.onAwaitingApproval?.(info);
    });
    const signed = TransactionBuilder.fromXDR(signedTxXdr, opts.networkPassphrase);
    assertSameTransaction(target.preparedHash, signed);
    const result = await submit(signed);
    clearPendingHandle(target.requestId);
    return result;
  } catch (e) {
    if (!keepsPendingHandle(e)) clearPendingHandle(target.requestId);
    throw e;
  } finally {
    endWait(target.requestId);
  }
}

/** The time bound of a prepared transaction, in unix seconds. */
function maxTimeOf(prepared: Transaction, signer: WalletSigner): number {
  const maxTime = Number(prepared.timeBounds?.maxTime ?? 0);
  return maxTime > 0 ? maxTime : Math.floor(Date.now() / 1000) + signer.txTimeoutSeconds;
}

/**
 * Signs a prepared transaction with one signer, then sends it with `submit`.
 * When the signature waits for an approval, the page saves a pending handle
 * (with `opts.pending`), polls the approval, and sends after the approval.
 */
export async function signAndSubmit(
  signer: WalletSigner,
  prepared: Transaction,
  opts: { address: string; networkPassphrase: string; pending?: PendingContext } & TxOptions,
  submit: SubmitSigned
): Promise<{ hash: string }> {
  const outcome = await signer.signTransaction(prepared.toXDR(), {
    networkPassphrase: opts.networkPassphrase,
    address: opts.address,
  });

  if (!outcome.pending) {
    const signed = TransactionBuilder.fromXDR(outcome.signedTxXdr, opts.networkPassphrase);
    // A custody provider signs out of the user's sight, so it must return the same body.
    // The self-custody wallet shows the transaction to the user: its path stays as before.
    if (signer.id !== "wallets-kit") assertSameTransaction(prepared.hash().toString("hex"), signed);
    return submit(signed);
  }

  const target: WaitTarget = {
    requestId: outcome.pending.requestId,
    maxTime: maxTimeOf(prepared, signer),
    preparedHash: prepared.hash().toString("hex"),
  };
  if (opts.pending) {
    savePendingHandle({
      ...target,
      approvalId: outcome.pending.approvalId,
      address: opts.address,
      kind: opts.pending.kind,
      submitVia: opts.pending.submitVia,
      createdAt: new Date().toISOString(),
    });
  }
  return waitAndSubmit(target, outcome.pending, opts, submit);
}
