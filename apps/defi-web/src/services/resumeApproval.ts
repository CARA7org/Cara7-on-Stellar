/**
 * Resumes a saved pending handle after a reload or a new login (design
 * section 8.6). It polls the custody API every 3 s. After the approval, it
 * checks the signed hash against the prepared hash in the handle, sends the
 * transaction on the path of the handle, then removes the handle.
 */
import type { PendingHandle } from "./pendingHandle";
import { pendingApprovalFor, waitAndSubmit, type TxOptions } from "./signers";
import { NETWORK_PASSPHRASE, sendAndPoll } from "./trancheTx";
import { submitToHorizon } from "./trustline";

export function resumePendingAction(
  handle: PendingHandle,
  options: TxOptions = {}
): Promise<{ hash: string }> {
  // Soroban RPC for an invoke transaction, Horizon for a ChangeTrust.
  const submit = handle.submitVia === "horizon" ? submitToHorizon : sendAndPoll;
  return waitAndSubmit(
    handle,
    pendingApprovalFor(handle.requestId, handle.approvalId),
    { networkPassphrase: NETWORK_PASSPHRASE, ...options },
    submit
  );
}
