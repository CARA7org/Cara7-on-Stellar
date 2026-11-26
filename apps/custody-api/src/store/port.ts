import type { RequestSummary, SignDecision, SignStatus } from '../types.js';

// The storage port. The server uses the Prisma implementation. The tests use
// the in-memory implementation. Both give the same behavior.

export type InvestorRecord = {
  id: string;
  displayName: string;
  walletId: string;
  keyId: string;
  address: string;
  network: 'testnet' | 'mainnet';
  createdAt: Date;
};

export type PasskeyRecord = {
  id: string;
  investorId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
};

export type ChallengeKind = 'register' | 'login';

export type ChallengeRecord = {
  id: string;
  kind: ChallengeKind;
  challenge: string;
  displayName: string | null;
  expiresAt: Date;
};

export type SessionRecord = {
  tokenHash: string;
  investorId: string;
  expiresAt: Date;
};

export type SigningRequestRecord = {
  id: string;
  investorId: string;
  dfnsSignatureId: string;
  keyId: string;
  preparedHash: string;
  status: SignStatus;
  approvalId: string | null;
  reason: string | null;
  decision: SignDecision;
  summary: RequestSummary;
  createdAt: Date;
  updatedAt: Date;
};

export type SigningRequestUpdate = Partial<
  Pick<SigningRequestRecord, 'status' | 'approvalId' | 'reason'>
>;

export interface CustodyStore {
  /// Stores a challenge and removes the challenges that expired before `now`.
  saveChallenge(challenge: ChallengeRecord, now: Date): Promise<void>;
  /// Removes the challenge and returns it. A challenge works only once.
  takeChallenge(id: string): Promise<ChallengeRecord | null>;

  createInvestor(investor: Omit<InvestorRecord, 'createdAt'>, passkey: PasskeyRecord): Promise<InvestorRecord>;
  findInvestor(id: string): Promise<InvestorRecord | null>;
  findPasskey(credentialId: string): Promise<PasskeyRecord | null>;
  updatePasskeyCounter(credentialId: string, counter: number): Promise<void>;

  createSession(session: SessionRecord): Promise<void>;
  findSession(tokenHash: string): Promise<SessionRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;

  createSigningRequest(
    request: Omit<SigningRequestRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<SigningRequestRecord>;
  findSigningRequest(id: string): Promise<SigningRequestRecord | null>;
  findPendingSigningRequests(investorId: string): Promise<SigningRequestRecord[]>;
  updateSigningRequest(id: string, update: SigningRequestUpdate): Promise<SigningRequestRecord>;
}
