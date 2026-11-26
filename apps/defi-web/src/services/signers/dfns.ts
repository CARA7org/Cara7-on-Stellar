import {
  CustodyError,
  fetchSignature,
  me,
  requestSignature,
  type SignResult,
} from "../custody";
import {
  SignerError,
  type ApprovalState,
  type PendingApproval,
  type WalletSigner,
} from "./types";

/** A policy approval can take a human decision, so the transaction stays valid for 30 minutes. */
const DFNS_TX_TIMEOUT_SECONDS = 1800;

export const APPROVAL_EXPIRED = "The approval request expired.";

function stateOf(result: SignResult): ApprovalState {
  switch (result.status) {
    case "signed":
      return result.signedTxXdr
        ? { status: "approved", signedTxXdr: result.signedTxXdr }
        : { status: "failed", reason: "The custody provider returned no signed transaction." };
    case "rejected":
      return { status: "denied", reason: result.reason ?? "no reason given" };
    case "failed":
      return { status: "failed", reason: result.reason ?? "no reason given" };
    default:
      return { status: "pending", approvalId: result.approvalId };
  }
}

/** The custody API or Dfns is down for a short time: the next poll can succeed. */
function isTransient(e: unknown): boolean {
  return e instanceof CustodyError && (e.status === 0 || e.status >= 500);
}

/** A pending approval that polls `GET /sign/:requestId`. A resume after a reload also uses it. */
export function pendingApprovalFor(requestId: string, approvalId: string | null): PendingApproval {
  return {
    approvalId,
    requestId,
    async poll() {
      try {
        return stateOf(await fetchSignature(requestId));
      } catch (e) {
        if (isTransient(e)) return { status: "pending" };
        if (e instanceof CustodyError && e.code === "expired") {
          throw new SignerError("expired", APPROVAL_EXPIRED);
        }
        throw e;
      }
    },
  };
}

/** Converts a final state that is not an approval into a readable error. */
export function signerErrorOf(state: ApprovalState): SignerError {
  if (state.status === "denied") {
    return new SignerError(
      "denied",
      `Your policy approver denied this action: ${state.reason}`,
      state.reason
    );
  }
  const reason = state.status === "failed" ? state.reason : "unknown state";
  return new SignerError("failed", `The custody provider could not sign this action: ${reason}`, reason);
}

/**
 * The Dfns policy signer. The custody API starts the signature request with
 * its Dfns service account. The wallet policy can ask for an approval, so
 * the result can be pending. The custody API guard can refuse the
 * transaction before Dfns sees it (HTTP 422).
 */
export const dfnsSigner: WalletSigner = {
  id: "dfns",
  txTimeoutSeconds: DFNS_TX_TIMEOUT_SECONDS,

  async getAddress() {
    const investor = await me();
    return investor.address;
  },

  async signTransaction(xdr, { networkPassphrase }) {
    let result: SignResult;
    try {
      result = await requestSignature(xdr, networkPassphrase);
    } catch (e) {
      if (e instanceof CustodyError && e.code === "not_allowed") {
        throw new SignerError(
          "blocked",
          `The wallet policy does not allow this action: ${e.message}`,
          e.message
        );
      }
      throw e;
    }
    const state = stateOf(result);
    if (state.status === "approved") return { signedTxXdr: state.signedTxXdr };
    if (state.status === "pending") {
      return { pending: pendingApprovalFor(result.requestId, result.approvalId ?? null) };
    }
    throw signerErrorOf(state);
  },
};
