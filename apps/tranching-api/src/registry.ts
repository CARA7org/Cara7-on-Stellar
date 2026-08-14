import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from './generated/prisma/client.js';
import { prisma } from './db.js';
import { environment } from './config.js';
import { trancheStats, dealPhase } from './metrics.js';

const SENIORITIES = ['SENIOR', 'MEZZANINE', 'JUNIOR'] as const;

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
  seniority: z.enum(SENIORITIES),
  contractId: contractIdSchema,
  baseAssetId: contractIdSchema.default(environment.SEED_BASE_ASSET_ID),
  originalFace: z.string().regex(/^\d+$/, 'originalFace en unites de base'),
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
            couponBps: 281,
            contractId: environment.SEED_NOTE_A_ID,
            baseAssetId: environment.SEED_BASE_ASSET_ID,
            originalFace: new Prisma.Decimal('1000000000000'), // 100,000 EURC
            assetSymbol: environment.SEED_ASSET_SYMBOL,
            assetDecimals: 7,
          },
          {
            name: 'Class B Notes',
            seniority: 'MEZZANINE',
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
      include: { tranches: { orderBy: { id: 'asc' } } },
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
    const deal = await prisma.deal.findUnique({ where: { id: params.data.id } });
    if (!deal) return reply.status(404).send({ error: 'Deal introuvable' });
    const duplicate = await prisma.tranche.findUnique({ where: { contractId: body.data.contractId } });
    if (duplicate) return reply.status(409).send({ error: 'This contract is already registered' });
    const tranche = await prisma.tranche.create({
      data: {
        dealId: deal.id,
        ...body.data,
        originalFace: new Prisma.Decimal(body.data.originalFace),
      },
    });
    return reply
      .status(201)
      .send({ tranche: { ...tranche, originalFace: tranche.originalFace.toString() } });
  });

  app.get('/api/tranches', async () => {
    const tranches = await prisma.tranche.findMany({
      orderBy: { id: 'asc' },
      include: { deal: { select: { name: true } } },
    });
    return {
      tranches: await Promise.all(
        tranches.map(async (tranche) => ({
          id: tranche.id,
          dealId: tranche.dealId,
          dealName: tranche.deal.name,
          name: tranche.name,
          seniority: tranche.seniority,
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

  // Distribution history of the waterfall v4: grouped by PERIOD (the topic of
  // the `distribution` event), detailed by rank and by class - the pushes of
  // the paying agent land in later ledgers.
  app.get('/api/deals/:id/distributions', async (request, reply) => {
    const params = identifierParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Identifiant invalide' });
    const deal = await prisma.deal.findUnique({
      where: { id: params.data.id },
      include: { tranches: { orderBy: { id: 'asc' } } },
    });
    if (!deal) return reply.status(404).send({ error: 'Deal introuvable' });
    const emptySchedule = {
      periodDays: deal.periodDays,
      periodNumber: 1,
      dueAt: new Date(deal.createdAt.getTime() + deal.periodDays * 86_400_000),
    };
    if (!deal.dealContractId) return { distributions: [], schedule: emptySchedule };

    const trancheBySeniority = new Map(
      deal.tranches.map((tranche) => [
        ['SENIOR', 'MEZZANINE', 'JUNIOR'].indexOf(tranche.seniority),
        tranche.contractId,
      ]),
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
          ],
        },
      },
      orderBy: { id: 'desc' },
      take: 400,
    });

    interface PerClass {
      tranche: string | null;
      class: number;
      interest: string;
      principal: string;
      shortfall: string;
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
    for (const event of events) {
      const topic = event.topic as unknown[];
      const data = Array.isArray(event.data) ? (event.data as string[]) : [String(event.data)];
      const topicPeriod = Number(topic[1] ?? NaN);
      const period =
        event.type === 'distribution'
          ? topicPeriod
          : (periodByLedger.get(event.ledger) ?? NaN);
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
        case 'fees_paid':
          row.fees = String(data[0] ?? '0');
          break;
        case 'interest_paid': {
          // topics [interest_paid, class], data [period, due, paid, shortfall, dust]
          const classIndex = Number(topic[1] ?? 0);
          const entry = perClassEntry(row, classIndex, trancheBySeniority);
          entry.interest = String(data[2] ?? '0');
          entry.shortfall = String(data[3] ?? '0');
          break;
        }
        case 'principal_paid': {
          // topics [principal_paid, class], data [period, paid, per_note, outstanding_after]
          const classIndex = Number(topic[1] ?? 0);
          const entry = perClassEntry(row, classIndex, trancheBySeniority);
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
