import { z } from 'zod';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { RequestSummary } from '../types.js';
import type {
  ChallengeRecord,
  CustodyStore,
  InvestorRecord,
  PasskeyRecord,
  SessionRecord,
  SigningRequestRecord,
  SigningRequestUpdate,
} from './port.js';

const summarySchema = z.object({
  kind: z.enum(['subscribe', 'cancel', 'claim', 'change_trust']),
  contractId: z.string().optional(),
  classIndex: z.number().int().optional(),
  notes: z.string().optional(),
  amountEurc: z.string().optional(),
  limit: z.string().optional(),
});
const statusSchema = z.enum(['signed', 'pending', 'rejected', 'failed']);
const decisionSchema = z.enum(['auto', 'needs_approval']);
const challengeKindSchema = z.enum(['register', 'login']);
const networkSchema = z.enum(['testnet', 'mainnet']);

type InvestorRow = Prisma.InvestorGetPayload<object>;
type PasskeyRow = Prisma.PasskeyGetPayload<object>;
type SigningRequestRow = Prisma.SigningRequestGetPayload<object>;

/// The PostgreSQL store (schema `custody`).
export class PrismaStore implements CustodyStore {
  constructor(private readonly prisma: PrismaClient) {}

  async saveChallenge(challenge: ChallengeRecord, now: Date): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.challenge.deleteMany({ where: { expiresAt: { lt: now } } }),
      this.prisma.challenge.create({ data: challenge }),
    ]);
  }

  async takeChallenge(id: string): Promise<ChallengeRecord | null> {
    const row = await this.prisma.challenge.findUnique({ where: { id } });
    if (!row) return null;
    // The delete is the atomic step: only one parallel call gets count 1.
    const { count } = await this.prisma.challenge.deleteMany({ where: { id } });
    if (count === 0) return null;
    return {
      id: row.id,
      kind: challengeKindSchema.parse(row.kind),
      challenge: row.challenge,
      displayName: row.displayName,
      expiresAt: row.expiresAt,
    };
  }

  async createInvestor(
    investor: Omit<InvestorRecord, 'createdAt'>,
    passkey: PasskeyRecord,
  ): Promise<InvestorRecord> {
    const row = await this.prisma.investor.create({
      data: {
        ...investor,
        passkeys: {
          create: {
            id: passkey.id,
            publicKey: new Uint8Array(passkey.publicKey),
            counter: BigInt(passkey.counter),
            transports: passkey.transports,
          },
        },
      },
    });
    return toInvestor(row);
  }

  async findInvestor(id: string): Promise<InvestorRecord | null> {
    const row = await this.prisma.investor.findUnique({ where: { id } });
    return row ? toInvestor(row) : null;
  }

  async findPasskey(credentialId: string): Promise<PasskeyRecord | null> {
    const row = await this.prisma.passkey.findUnique({ where: { id: credentialId } });
    return row ? toPasskey(row) : null;
  }

  async updatePasskeyCounter(credentialId: string, counter: number): Promise<void> {
    await this.prisma.passkey.update({
      where: { id: credentialId },
      data: { counter: BigInt(counter) },
    });
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.prisma.session.create({ data: session });
  }

  async findSession(tokenHash: string): Promise<SessionRecord | null> {
    const row = await this.prisma.session.findUnique({ where: { tokenHash } });
    return row ? { tokenHash: row.tokenHash, investorId: row.investorId, expiresAt: row.expiresAt } : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash } });
  }

  async createSigningRequest(
    request: Omit<SigningRequestRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<SigningRequestRecord> {
    const row = await this.prisma.signingRequest.create({
      data: { ...request, summary: toJson(request.summary) },
    });
    return toSigningRequest(row);
  }

  async findSigningRequest(id: string): Promise<SigningRequestRecord | null> {
    const row = await this.prisma.signingRequest.findUnique({ where: { id } });
    return row ? toSigningRequest(row) : null;
  }

  async findPendingSigningRequests(investorId: string): Promise<SigningRequestRecord[]> {
    const rows = await this.prisma.signingRequest.findMany({
      where: { investorId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toSigningRequest);
  }

  async updateSigningRequest(id: string, update: SigningRequestUpdate): Promise<SigningRequestRecord> {
    const row = await this.prisma.signingRequest.update({ where: { id }, data: update });
    return toSigningRequest(row);
  }
}

function toInvestor(row: InvestorRow): InvestorRecord {
  return { ...row, network: networkSchema.parse(row.network) };
}

function toPasskey(row: PasskeyRow): PasskeyRecord {
  return {
    id: row.id,
    investorId: row.investorId,
    publicKey: new Uint8Array(row.publicKey),
    counter: Number(row.counter),
    transports: row.transports,
  };
}

function toSigningRequest(row: SigningRequestRow): SigningRequestRecord {
  return {
    ...row,
    status: statusSchema.parse(row.status),
    decision: decisionSchema.parse(row.decision),
    summary: summarySchema.parse(row.summary),
  };
}

/// Drops the undefined fields, so that the value fits a Json column.
function toJson(summary: RequestSummary): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined),
  ) as Prisma.InputJsonObject;
}
