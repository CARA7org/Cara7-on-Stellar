// The HTTP contract that the investor front uses. Keep these shapes stable.

export type InvestorView = {
  id: string;
  displayName: string;
  address: string;
  walletId: string;
  network: 'testnet' | 'mainnet';
};

export type SignStatus = 'signed' | 'pending' | 'rejected' | 'failed';

/// The checker verdict that the guard expects: approve gives auto,
/// abstain gives needs_approval (a person approves in the Dfns dashboard).
export type SignDecision = 'auto' | 'needs_approval';

export type RequestSummary = {
  kind: 'subscribe' | 'cancel' | 'claim' | 'change_trust';
  contractId?: string;
  classIndex?: number;
  notes?: string;
  amountEurc?: string;
  limit?: string;
};

export type SignResult = {
  requestId: string;
  status: SignStatus;
  signedTxXdr?: string;
  approvalId?: string;
  reason?: string;
  decision: SignDecision;
  summary: RequestSummary;
};

export type SessionView = {
  sessionToken: string;
  expiresAt: string;
  investor: InvestorView;
};
