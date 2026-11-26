import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from './generated/prisma/client.js';
import { prisma } from './db.js';
import { environment } from './config.js';
import { trancheStats, dealPhase } from './metrics.js';
import {
  readPayoutParked,
  readPeriodSettled,
  readRankLines,
  readTriggerBreached,
  settlementChecks,
  type PeriodSettlement,
  type RankItemKind,
} from './decode.js';

const SENIORITIES = ['SENIOR', 'MEZZANINE', 'JUNIOR'] as const;
const RATE_KINDS = ['FLOATING', 'FIXED'] as const;
/// The abs-deal contract allows 1 to 8 note classes: class index 0 to 7.
const MAX_CLASSES = 8;
const CLASS_INDEX_RULE = `classIndex must be an integer from 0 to ${MAX_CLASSES - 1}`;

/// Smallest class index that the deal does not use yet, or null when the deal
/// already has MAX_CLASSES classes.
export function nextFreeClassIndex(used: readonly number[]): number | null {
  for (let classIndex = 0; classIndex < MAX_CLASSES; classIndex++) {
    if (!used.includes(classIndex)) return classIndex;
  }
  return null;
}

const contractIdSchema = z
  .string()
  .length(56)
  .regex(/^C[A-Z2-7]{55}$/, 'contractId Soroban invalide (strkey C...)');

const dealBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  // Contracts of the generation backing this deal - required for the poller
  // to ingest it and for the front to read its lifecycle phase.
  dealContractId: contractIdSchema.optional(),
  payingAgentContractId: contractIdSchema.optional(),
  periodDays: z.number().int().min(1).max(90).optional(),
});

const trancheBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Display label only. Two classes of one deal can have the same label.
  seniority: z.enum(SENIORITIES),
  // On-chain class index, senior first. When it is absent, the route takes
  // the next free index of the deal.
  classIndex: z
    .number()
    .int(CLASS_INDEX_RULE)
    .min(0, CLASS_INDEX_RULE)
    .max(MAX_CLASSES - 1, CLASS_INDEX_RULE)
    .optional(),
  contractId: contractIdSchema,
  baseAssetId: contractIdSchema.default(environment.SEED_BASE_ASSET_ID),
  originalFace: z.string().regex(/^\d+$/, 'originalFace en unites de base'),
  rateKind: z.enum(RATE_KINDS).default('FIXED'),
  // FIXED: annual rate in bps. FLOATING: spread over EURIBOR 1M in bps.
  couponBps: z.number().int().min(0).max(10000).default(0),
  assetSymbol: z.string().trim().min(1).max(12).default('EURC'),
  assetDecimals: z.number().int().min(0).max(18).default(7),
});

const identifierParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/// First-start seed: the demo deal pointing at the v4 generation (abs-deal +
/// note tokens + paying agent) on testnet.
export async function seedRegistry(): Promise<void> {
  const dealCount = await prisma.deal.count();
  if (dealCount > 0) return;
  await prisma.deal.create({
    data: {
      name: environment.SEED_DEAL_NAME,
      description:
        'Auto lease ABS deal - CARA7 notes on Stellar testnet: subscription escrow, closing DvP, waterfall v4, paying agent.',
      dealContractId: environment.SEED_DEAL_CONTRACT_ID,
      payingAgentContractId: environment.SEED_PAYING_AGENT_ID,
      tranches: {
        create: [
          {
            name: 'Class A Notes',
            seniority: 'SENIOR',
            classIndex: 0,
            // EURIBOR 1M + 0.60% (floor 0%): couponBps is the spread.
            rateKind: 'FLOATING',
            couponBps: 60,
            contractId: environment.SEED_NOTE_A_ID,
            baseAssetId: environment.SEED_BASE_ASSET_ID,
            originalFace: new Prisma.Decimal('1000000000000'), // 100,000 EURC
            assetSymbol: environment.SEED_ASSET_SYMBOL,
            assetDecimals: 7,
          },
          {
            name: 'Class B Notes',
            seniority: 'MEZZANINE',
            classIndex: 1,
            rateKind: 'FIXED',
            couponBps: 100,
            contractId: environment.SEED_NOTE_B_ID,
            baseAssetId: environment.SEED_BASE_ASSET_ID,
            originalFace: new Prisma.Decimal('700000000000'), // 70,000 EURC
            assetSymbol: environment.SEED_ASSET_SYMBOL,
            assetDecimals: 7,
          },
          {
            name: 'Class C Notes',
            seniority: 'JUNIOR',
            classIndex: 2,
            rateKind: 'FIXED',
            couponBps: 150,
            contractId: environment.SEED_NOTE_C_ID,
            baseAssetId: environment.SEED_BASE_ASSET_ID,
            originalFace: new Prisma.Decimal('450000000000'), // 45,000 EURC
            assetSymbol: environment.SEED_ASSET_SYMBOL,
            assetDecimals: 7,
          },
        ],
      },
    },
  });
}

export async function registryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/deals', async () => {
    const deals = await prisma.deal.findMany({
      orderBy: { createdAt: 'asc' },
      include: { tranches: { orderBy: { classIndex: 'asc' } } },
    });
    return {
      deals: await Promise.all(
        deals.map(async (deal) => ({
          ...deal,
          tranches: deal.tranches.map((tranche) => ({
            ...tranche,
            originalFace: tranche.originalFace.toString(),
          })),
          phase: await dealPhase(deal.dealContractId),
        })),
      ),
    };
  });

  app.post('/api/deals', async (request, reply) => {
    const parseResult = dealBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues[0]?.message ?? 'Corps invalide' });
    }
    const existing = await prisma.deal.findUnique({ where: { name: parseResult.data.name } });
    if (existing) return reply.status(409).send({ error: 'A deal already carries this name' });
    const deal = await prisma.deal.create({
      data: {
        name: parseResult.data.name,
        description: parseResult.data.description ?? null,
        dealContractId: parseResult.data.dealContractId ?? null,
        payingAgentContractId: parseResult.data.payingAgentContractId ?? null,
        ...(parseResult.data.periodDays ? { periodDays: parseResult.data.periodDays } : {}),
      },
    });
    return reply.status(201).send({ deal });
  });

  app.post('/api/deals/:id/tranches', async (request, reply) => {
    const params = identifierParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Identifiant invalide' });
    const body = trancheBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'Corps invalide' });
    }
    const deal = await prisma.deal.findUnique({
      where: { id: params.data.id },
      include: { tranches: { select: { classIndex: true, name: true } } },
    });
    if (!deal) return reply.status(404).send({ error: 'Deal introuvable' });
    const duplicate = await prisma.tranche.findUnique({ where: { contractId: body.data.contractId } });
    if (duplicate) return reply.status(409).send({ error: 'This contract is already registered' });
    const classIndex =
      body.data.classIndex ?? nextFreeClassIndex(deal.tranches.map((existing) => existing.classIndex));
    if (classIndex === null) {
      return reply.status(409).send({
        error: `This deal already has ${MAX_CLASSES} note classes (class index 0 to ${MAX_CLASSES - 1})`,
      });
    }
    const owner = deal.tranches.find((existing) => existing.classIndex === classIndex);
    if (owner) {
      return reply.status(409).send({
        error: `Class index ${classIndex} is already used in this deal by "${owner.name}". Each class of a deal needs its own class index.`,
      });
    }
    let tranche;
    try {
      tranche = await prisma.tranche.create({
        data: {
          dealId: deal.id,
          ...body.data,
          classIndex,
          originalFace: new Prisma.Decimal(body.data.originalFace),
        },
      });
    } catch (error) {
      // Two requests at the same time can both pass the checks above. The
      // unique indexes (contract, deal + class index) then refuse the second.
      if ((error as { code?: string }).code === 'P2002') {
        return reply
          .status(409)
          .send({ error: 'This contract or this class index is already registered for this deal' });
      }
      throw error;
    }
    return reply
      .status(201)
      .send({ tranche: { ...tranche, originalFace: tranche.originalFace.toString() } });
  });

  app.get('/api/tranches', async () => {
    const tranches = await prisma.tranche.findMany({
      orderBy: [{ dealId: 'asc' }, { classIndex: 'asc' }],
      include: { deal: { select: { name: true } } },
    });
    return {
      tranches: await Promise.all(
        tranches.map(async (tranche) => ({
          id: tranche.id,
          dealId: tranche.dealId,
          dealName: tranche.deal.name,
          name: tranche.name,
          classIndex: tranche.classIndex,
          seniority: tranche.seniority,
          rateKind: tranche.rateKind,
          couponBps: tranche.couponBps,
          contractId: tranche.contractId,
          baseAssetId: tranche.baseAssetId,
          originalFace: tranche.originalFace.toString(),
          assetSymbol: tranche.assetSymbol,
          assetDecimals: tranche.assetDecimals,
          stats: await trancheStats(tranche.contractId),
        })),
      ),
    };
  });

  app.get('/api/tranches/:id', async (request, reply) => {
    const params = identifierParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Identifiant invalide' });
    const tranche = await prisma.tranche.findUnique({
      where: { id: params.data.id },
      include: { deal: { select: { name: true, description: true } } },
    });
    if (!tranche) return reply.status(404).send({ error: 'Tranche introuvable' });
    return {
      tranche: {
        ...tranche,
        originalFace: tranche.originalFace.toString(),
        stats: await trancheStats(tranche.contractId),
      },
    };
  });

  // Distribution history of the waterfall: grouped by PERIOD (the topic of
  // the `distribution` event), detailed by rank and by class - the pushes of
  // the paying agent land in later ledgers. A deal of the rank engine also
  // gives its rank lines, its settlement, its triggers and its parked payouts.
  app.get('/api/deals/:id/distributions', async (request, reply) => {
    const params = identifierParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Identifiant invalide' });
    const deal = await prisma.deal.findUnique({
      where: { id: params.data.id },
      include: { tranches: { orderBy: { classIndex: 'asc' } } },
    });
    if (!deal) return reply.status(404).send({ error: 'Deal introuvable' });
    const emptySchedule = {
      periodDays: deal.periodDays,
      periodNumber: 1,
      dueAt: new Date(deal.createdAt.getTime() + deal.periodDays * 86_400_000),
    };
    if (!deal.dealContractId) return { distributions: [], schedule: emptySchedule };

    // On-chain class index -> note-token contract (the seniority is a label only).
    const trancheByClass = new Map(
      deal.tranches.map((tranche) => [tranche.classIndex, tranche.contractId]),
    );

    const events = await prisma.stellarEvent.findMany({
      where: {
        contractId: deal.dealContractId,
        type: {
          in: [
            'distribution',
            'fees_paid',
            'interest_paid',
            'principal_paid',
            'reserve_released',
            'reserve_refunded',
            'residual_paid',
            'carry_updated',
            'rank_lines',
            'period_settled',
            'trigger_breached',
            'payout_parked',
          ],
        },
      },
      orderBy: { id: 'desc' },
      // A period of 8 classes and 4 fee lines has 36 of these events at most:
      // 2,000 events are 55 periods at least.
      take: 2000,
    });

    interface PerClass {
      tranche: string | null;
      class: number;
      interest: string;
      principal: string;
      shortfall: string;
    }
    interface RankRow {
      /// The id of the rank in the configuration of the deal.
      rank: string;
      item: RankItemKind;
      /// The class of an interest or a principal line. Null for the other items.
      class: number | null;
      /// The fee line of a fee item. Null for the other items.
      feeIndex: number | null;
      due: string;
      paid: string;
      dust: string;
    }
    interface SettlementRow extends Omit<PeriodSettlement, 'period'> {
      /// collections + reserveIn + carryIn == paidOut + reserve + carry.
      conserved: boolean;
      /// balance >= reserve + carry + owed.
      covered: boolean;
    }
    interface Row {
      period: number;
      ts: Date;
      ledger: number;
      collections: string;
      reserveReleased: string;
      carryIn: string;
      ada: string;
      total: string;
      residual: string;
      fees: string;
      reserveRefunded: string;
      carryOut: string;
      perClass: PerClass[];
      /// payments keeps its historical shape { noteContract: classAmount }.
      payments: Record<string, string>;
      /// Rank engine: the lines of the period, in the order of execution. A
      /// deal of the earlier code has no line and no settlement.
      ranks: RankRow[];
      settlement: SettlementRow | null;
      /// The triggers that were set in this period and not before.
      triggers: { id: string }[];
      /// The payouts that failed and stay in the deal, owed to their recipient.
      parked: { recipient: string; rank: number; amount: string }[];
    }
    const byPeriod = new Map<number, Row>();
    const rowFor = (period: number, event: { ts: Date; ledger: number }): Row => {
      const existing = byPeriod.get(period);
      if (existing) return existing;
      const created: Row = {
        period,
        ts: event.ts,
        ledger: event.ledger,
        collections: '0',
        reserveReleased: '0',
        carryIn: '0',
        ada: '0',
        total: '0',
        residual: '0',
        fees: '0',
        reserveRefunded: '0',
        carryOut: '0',
        perClass: [],
        payments: {},
        ranks: [],
        settlement: null,
        triggers: [],
        parked: [],
      };
      byPeriod.set(period, created);
      return created;
    };

    // Events with no period in their topic (reserve/residual/fees) attach to
    // the period of the same ledger.
    const periodByLedger = new Map<number, number>();
    for (const event of events) {
      if (event.type === 'distribution') {
        periodByLedger.set(event.ledger, Number((event.topic as unknown[])[1] ?? 0));
      }
    }
    // The period of an event: its own period when the event carries one in
    // its topic (distribution, rank_lines, period_settled) or first in its
    // data (trigger_breached, payout_parked). Else the period of the
    // `distribution` event of the same ledger.
    const periodOf = (type: string, topic: unknown[], data: string[], ledger: number): number => {
      switch (type) {
        case 'distribution':
        case 'rank_lines':
        case 'period_settled':
          return Number(topic[1] ?? NaN);
        case 'trigger_breached':
        case 'payout_parked':
          return Number(data[0] ?? NaN);
        default:
          return periodByLedger.get(ledger) ?? NaN;
      }
    };
    // The events come from the latest to the earliest.
    for (const event of events) {
      const topic = event.topic as unknown[];
      const data = Array.isArray(event.data) ? (event.data as string[]) : [String(event.data)];
      const period = periodOf(event.type, topic, data, event.ledger);
      if (!Number.isFinite(period)) continue;
      const row = rowFor(period, event);
      switch (event.type) {
        case 'distribution': {
          // data [collections, reserve_released, carry_in, ada]
          row.ts = event.ts;
          row.ledger = event.ledger;
          row.collections = String(data[0] ?? '0');
          row.reserveReleased = String(data[1] ?? '0');
          row.carryIn = String(data[2] ?? '0');
          row.ada = String(data[3] ?? '0');
          row.total = row.collections;
          break;
        }
        case 'fees_paid': {
          // One event for each fee line that was paid: the row gives their sum.
          const amount = String(data[0] ?? '0');
          if (/^\d+$/.test(amount)) row.fees = (BigInt(row.fees) + BigInt(amount)).toString();
          break;
        }
        case 'interest_paid': {
          // topics [interest_paid, class], data [period, due, paid, shortfall, dust]
          const classIndex = Number(topic[1] ?? 0);
          const entry = perClassEntry(row, classIndex, trancheByClass);
          entry.interest = String(data[2] ?? '0');
          entry.shortfall = String(data[3] ?? '0');
          break;
        }
        case 'principal_paid': {
          // topics [principal_paid, class], data [period, paid, per_note, outstanding_after]
          const classIndex = Number(topic[1] ?? 0);
          const entry = perClassEntry(row, classIndex, trancheByClass);
          entry.principal = String(data[1] ?? '0');
          break;
        }
        case 'reserve_refunded':
          row.reserveRefunded = String(data[0] ?? '0');
          break;
        case 'residual_paid':
          row.residual = String(data[0] ?? '0');
          break;
        case 'carry_updated':
          row.carryOut = String(data[1] ?? '0');
          break;
        case 'rank_lines': {
          const rankLines = readRankLines(topic, event.data);
          if (!rankLines) break;
          row.ranks = rankLines.lines.map((line) => ({
            rank: line.rank,
            item: line.item.kind,
            class: line.item.kind === 'interest' || line.item.kind === 'principal' ? line.item.index : null,
            feeIndex: line.item.kind === 'fee' ? line.item.index : null,
            due: line.due,
            paid: line.paid,
            dust: line.dust,
          }));
          break;
        }
        case 'period_settled': {
          const settlement = readPeriodSettled(topic, event.data);
          if (!settlement) break;
          row.settlement = {
            collections: settlement.collections,
            reserveIn: settlement.reserveIn,
            carryIn: settlement.carryIn,
            drawn: settlement.drawn,
            paidOut: settlement.paidOut,
            reserve: settlement.reserve,
            carry: settlement.carry,
            owed: settlement.owed,
            balance: settlement.balance,
            surplus: settlement.surplus,
            ...settlementChecks(settlement),
          };
          break;
        }
        case 'trigger_breached': {
          const breached = readTriggerBreached(topic, event.data);
          // `unshift`: the latest event comes first, the row keeps the event order.
          if (breached) row.triggers.unshift({ id: breached.id });
          break;
        }
        case 'payout_parked': {
          const parked = readPayoutParked(topic, event.data);
          if (parked) {
            row.parked.unshift({ recipient: parked.recipient, rank: parked.rank, amount: parked.amount });
          }
          break;
        }
        default:
          break;
      }
    }
    for (const row of byPeriod.values()) {
      for (const entry of row.perClass) {
        if (!entry.tranche) continue;
        const amount = BigInt(entry.interest) + BigInt(entry.principal);
        row.payments[entry.tranche] = amount.toString();
      }
    }

    const distributions = [...byPeriod.values()].sort((a, b) => b.period - a.period);
    const lastTs = distributions[0]?.ts ?? deal.createdAt;
    return {
      distributions,
      schedule: {
        periodDays: deal.periodDays,
        periodNumber: (distributions[0]?.period ?? 0) + 1,
        dueAt: new Date(new Date(lastTs).getTime() + deal.periodDays * 86_400_000),
      },
    };

    function perClassEntry(
      row: Row,
      classIndex: number,
      tranches: Map<number, string>,
    ): PerClass {
      let entry = row.perClass.find((candidate) => candidate.class === classIndex);
      if (!entry) {
        entry = {
          tranche: tranches.get(classIndex) ?? null,
          class: classIndex,
          interest: '0',
          principal: '0',
          shortfall: '0',
        };
        row.perClass.push(entry);
        row.perClass.sort((a, b) => a.class - b.class);
      }
      return entry;
    }
  });

  app.get('/api/stats', async () => {
    const [deals, tranches, events, snapshots] = await Promise.all([
      prisma.deal.count(),
      prisma.tranche.count(),
      prisma.stellarEvent.count(),
      prisma.trancheSnapshot.count(),
    ]);
    return { deals, tranches, events, snapshots };
  });
}
