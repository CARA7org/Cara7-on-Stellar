/**
 * The signer port. One adapter for each wallet provider signs a prepared
 * transaction envelope. An adapter never rebuilds the transaction. The
 * pipeline in trancheTx.ts builds, simulates, sends and polls. It does not
 * know which provider signs.
 */

export type ProviderId = "wallets-kit" | "dfns";

export interface SignOptions {
  networkPassphrase: string;
  /** The G-address that signs. It is the transaction source. */
  address: string;
}

/** The state of a pending approval at one poll. */
export type ApprovalState =
  | { status: "approved"; signedTxXdr: string }
  | { status: "denied"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "pending"; approvalId?: string };

/**
 * A signature that waits for a policy approval. The caller polls it until
 * the approver decides. After the approval, the poll gives the signed XDR.
 */
export interface PendingApproval {
  /** The approval id in the custody provider. Null until the provider gives one. */
  approvalId: string | null;
  /** The signature request id in the custody provider. */
  requestId: string;
  poll(): Promise<ApprovalState>;
}

/** A signer gives the signed XDR now, or a pending approval. */
export type SignOutcome =
  | { signedTxXdr: string; pending?: undefined }
  | { signedTxXdr?: undefined; pending: PendingApproval };

export interface WalletSigner {
  readonly id: ProviderId;
  /** The validity window of a transaction that this signer signs, in seconds. */
  readonly txTimeoutSeconds: number;
  /** The G-address of the connected wallet. */
  getAddress(): Promise<string>;
  signTransaction(xdr: string, opts: SignOptions): Promise<SignOutcome>;
}

/** What the UI shows while an action waits for an approval. */
export interface AwaitingApproval {
  approvalId: string | null;
  requestId: string;
}

/** Optional callbacks of a signed action. */
export interface TxOptions {
  /** Called when the action starts to wait for an approval, and when the approval id changes. */
  onAwaitingApproval?: (info: AwaitingApproval) => void;
}

/**
 * - denied: the policy approver denied the signature.
 * - blocked: the custody policy guard refused the transaction before signing.
 * - failed: the custody provider could not sign.
 * - expired: the approval did not come before the transaction time bound.
 * - changed: the signed transaction is not the prepared transaction.
 */
export type SignerErrorKind = "denied" | "blocked" | "failed" | "expired" | "changed";

/** A signing failure that the UI can show in the user's language. */
export class SignerError extends Error {
  readonly kind: SignerErrorKind;
  readonly reason: string | null;

  constructor(kind: SignerErrorKind, message: string, reason: string | null = null) {
    super(message);
    this.name = "SignerError";
    this.kind = kind;
    this.reason = reason;
  }
}
