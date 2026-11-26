import type { Account, Transaction, xdr } from '@stellar/stellar-sdk';

/**
 * The two ports of operator custody.
 *
 * - `OperatorCustody` gets a signature for a prepared transaction. The
 *   production implementation is Dfns (dfns.ts). The backend holds no key.
 * - `StellarNetwork` reads contracts, prepares and submits transactions. The
 *   production implementation is Soroban RPC and Horizon (waterfall/soroban.ts).
 *
 * Tests replace both ports with fakes, so they run offline.
 */

export const OPERATOR_ROLES = ['admin', 'servicer', 'reporter', 'crank'] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

/** Seconds that a prepared transaction stays valid. An approval can take time. */
export const TIME_BOUND_SECONDS: Record<OperatorRole, number> = {
  admin: 3600,
  servicer: 3600,
  reporter: 3600,
  crank: 120,
};

export function isOperatorRole(value: string): value is OperatorRole {
  return (OPERATOR_ROLES as readonly string[]).includes(value);
}

export interface RoleWallet {
  walletId: string;
  keyId: string;
  address: string;
}

export interface SignatureState {
  signatureId: string;
  status: 'pending' | 'signed' | 'rejected' | 'failed';
  approvalId?: string;
  /** The signed envelope, base64 XDR. Set only when the status is `signed`. */
  signedXdr?: string;
  /** A readable reason, when the status is `rejected` or `failed`. */
  reason?: string;
}

export interface SignatureInput {
  role: OperatorRole;
  transaction: Transaction;
  /** Idempotency key. The provider ignores it when it is longer than its limit. */
  externalId?: string;
}

export interface OperatorCustody {
  resolveRole(role: OperatorRole): Promise<RoleWallet>;
  requestSignature(input: SignatureInput): Promise<SignatureState>;
  refreshSignature(role: OperatorRole, signatureId: string): Promise<SignatureState>;
}

export interface ChainOutcome {
  hash: string;
  result: unknown;
}

export interface StellarNetwork {
  /** Loads the account of `address` with its current sequence number. */
  sourceAccount(address: string): Promise<Account>;
  /** Simulates a Soroban transaction and adds its footprint and resource fee. */
  prepare(transaction: Transaction): Promise<Transaction>;
  /** Read-only contract call through a simulation. */
  read(contractId: string, method: string, args?: xdr.ScVal[]): Promise<unknown>;
  /** Sends a signed Soroban transaction and waits for the result. */
  submitContractCall(signed: Transaction): Promise<ChainOutcome>;
  /** Sends a signed classic transaction (for example ChangeTrust) through Horizon. */
  submitClassic(signed: Transaction): Promise<ChainOutcome>;
}
