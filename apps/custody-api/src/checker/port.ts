// The approvals port of the checker. The checker uses the Dfns adapter with
// its own service account. The tests use a fake.

export type InvestorWallet = {
  walletId: string;
  keyId: string;
  address: string;
};

export type PendingSignature = {
  keyId: string;
  /// Transaction, Hash, Message, ...
  requestKind: string;
  network?: string;
  /// The transaction hex (with 0x) when requestKind is Transaction.
  transaction?: string;
};

export type PendingApproval = {
  id: string;
  activityKind: string;
  decisionCount: number;
  /// A signature request: the key tells which wallet signs.
  signature?: PendingSignature;
  /// A transfer, transaction or swap request names its wallet directly.
  walletId?: string;
};

export type DecisionValue = 'Approved' | 'Denied';

export interface ApprovalsPort {
  listInvestorWallets(): Promise<InvestorWallet[]>;
  listPendingApprovals(): Promise<PendingApproval[]>;
  createDecision(input: { approvalId: string; value: DecisionValue; reason: string }): Promise<void>;
}

/// Dfns refused the decision (HTTP 4xx). The checker does not try it again.
export class DecisionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionRefusedError';
  }
}
