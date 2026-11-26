import type {
  ChallengeRecord,
  CustodyStore,
  InvestorRecord,
  PasskeyRecord,
  SessionRecord,
  SigningRequestRecord,
  SigningRequestUpdate,
} from './port.js';

/// An in-memory store for the tests. It keeps the same rules as the Prisma
/// store: unique wallet and address, one use per challenge.
export class MemoryStore implements CustodyStore {
  readonly challenges = new Map<string, ChallengeRecord>();
  readonly investors = new Map<string, InvestorRecord>();
  readonly passkeys = new Map<string, PasskeyRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly signingRequests = new Map<string, SigningRequestRecord>();

  async saveChallenge(challenge: ChallengeRecord, now: Date): Promise<void> {
    for (const [id, stored] of this.challenges) {
      if (stored.expiresAt < now) this.challenges.delete(id);
    }
    this.challenges.set(challenge.id, { ...challenge });
  }

  async takeChallenge(id: string): Promise<ChallengeRecord | null> {
    const challenge = this.challenges.get(id) ?? null;
    this.challenges.delete(id);
    return challenge;
  }

  async createInvestor(
    investor: Omit<InvestorRecord, 'createdAt'>,
    passkey: PasskeyRecord,
  ): Promise<InvestorRecord> {
    for (const stored of this.investors.values()) {
      if (stored.walletId === investor.walletId || stored.address === investor.address) {
        throw new Error('An investor with this wallet already exists.');
      }
    }
    if (this.passkeys.has(passkey.id)) throw new Error('This passkey is already registered.');
    const record: InvestorRecord = { ...investor, createdAt: new Date() };
    this.investors.set(record.id, record);
    this.passkeys.set(passkey.id, { ...passkey });
    return { ...record };
  }

  async findInvestor(id: string): Promise<InvestorRecord | null> {
    const investor = this.investors.get(id);
    return investor ? { ...investor } : null;
  }

  async findPasskey(credentialId: string): Promise<PasskeyRecord | null> {
    const passkey = this.passkeys.get(credentialId);
    return passkey ? { ...passkey } : null;
  }

  async updatePasskeyCounter(credentialId: string, counter: number): Promise<void> {
    const passkey = this.passkeys.get(credentialId);
    if (passkey) passkey.counter = counter;
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, { ...session });
  }

  async findSession(tokenHash: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(tokenHash);
    return session ? { ...session } : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async createSigningRequest(
    request: Omit<SigningRequestRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<SigningRequestRecord> {
    for (const stored of this.signingRequests.values()) {
      if (stored.dfnsSignatureId === request.dfnsSignatureId) {
        throw new Error('This Dfns signature request is already stored.');
      }
    }
    const now = new Date();
    const record: SigningRequestRecord = { ...request, createdAt: now, updatedAt: now };
    this.signingRequests.set(record.id, record);
    return { ...record };
  }

  async findSigningRequest(id: string): Promise<SigningRequestRecord | null> {
    const request = this.signingRequests.get(id);
    return request ? { ...request } : null;
  }

  async findPendingSigningRequests(investorId: string): Promise<SigningRequestRecord[]> {
    return [...this.signingRequests.values()]
      .filter((request) => request.investorId === investorId && request.status === 'pending')
      .map((request) => ({ ...request }));
  }

  async updateSigningRequest(id: string, update: SigningRequestUpdate): Promise<SigningRequestRecord> {
    const request = this.signingRequests.get(id);
    if (!request) throw new Error(`Unknown signing request ${id}.`);
    Object.assign(request, update, { updatedAt: new Date() });
    return { ...request };
  }
}
