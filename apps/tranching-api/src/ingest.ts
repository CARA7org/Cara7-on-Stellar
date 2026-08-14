import { Prisma } from './generated/prisma/client.js';
import { server, latestLedger } from './stellar.js';
import { prisma, jsonSafe } from './db.js';
import { environment } from './config.js';
import { decodeEvent, positionDeltas, type DecodedEvent } from './decode.js';

const LEDGERS_PER_DAY = 17280; // ledgers de ~5 s
// Cold start: getEvents keeps about 7 days, but the queryable window is
// bounded; start about 1 day back.
const COLD_START_LOOKBACK = LEDGERS_PER_DAY;

const SENIORITY_ORDER = ['SENIOR', 'MEZZANINE', 'JUNIOR'] as const;

interface Logger {
  info: (message: string) => void;
  error: (message: string) => void;
}

async function startLedgerFor(contractId: string, latest: number): Promise<number> {
  const state = await prisma.ingestState.findUnique({ where: { contractId } });
  if (state) return state.lastLedger + 1;
  if (environment.START_LEDGER) return environment.START_LEDGER;
  return Math.max(1, latest - COLD_START_LOOKBACK);
}

/// Resolve (deal|agent contract, on-chain class index) -> note-token contract,
/// through the seniority order of the registry (class 0 = SENIOR,
/// 1 = MEZZANINE, 2 = JUNIOR).
async function resolveTranche(
  source: { deal?: string; agent?: string },
  classIndex: number,
): Promise<string | null> {
  const deal = await prisma.deal.findFirst({
    where: source.deal
      ? { dealContractId: source.deal }
      : { payingAgentContractId: source.agent },
    include: { tranches: true },
  });
  if (!deal) return null;
  const seniority = SENIORITY_ORDER[classIndex];
  if (!seniority) return null;
  return deal.tranches.find((tranche) => tranche.seniority === seniority)?.contractId ?? null;
}

/// One ingestion cycle for ONE contract: scan from the last ingested ledger,
/// dedup on the TOID, maintain user_position. Idempotent.
export async function ingestOnce(contractId: string, log?: Logger): Promise<number> {
  const latest = await latestLedger();
  const start = await startLedgerFor(contractId, latest);
  if (start > latest) return 0;

  let inserted = 0;
  let scannedTo = start - 1;
  let cursor: string | undefined;

  // getEvents returns a cursor on EVERY page (even an empty one) that moves
  // through the ledger range; paginate until it stops moving.
  for (let page = 0; page < 500; page++) {
    const filters = [{ type: 'contract' as const, contractIds: [contractId] }];
    const response = cursor
      ? await server.getEvents({ cursor, filters, limit: 100 })
      : await server.getEvents({ startLedger: start, filters, limit: 100 });

    for (const rawEvent of response.events) {
      const event = decodeEvent(rawEvent as Parameters<typeof decodeEvent>[0]);
      if (await persist(event)) inserted++;
      scannedTo = Math.max(scannedTo, event.ledger);
    }
    scannedTo = Math.max(scannedTo, response.latestLedger ?? scannedTo);

    const next = (response as { cursor?: string }).cursor;
    if (!next || next === cursor) break; // the cursor no longer moves: up to date
    cursor = next;
  }

  await prisma.ingestState.upsert({
    where: { contractId },
    create: { contractId, lastLedger: scannedTo },
    update: { lastLedger: scannedTo },
  });
  if (inserted) log?.info(`[ingest ${contractId.slice(0, 8)}] +${inserted} events, ledger → ${scannedTo}`);
  return inserted;
}

async function persist(event: DecodedEvent): Promise<boolean> {
  try {
    await prisma.stellarEvent.create({
      data: {
        id: event.id,
        ledger: event.ledger,
        ts: event.ts,
        contractId: event.contractId,
        type: event.type,
        topic: jsonSafe(event.topics) as Prisma.InputJsonValue,
        data: jsonSafe(event.data) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return false; // TOID deja ingere
    throw error;
  }

  // Deltas de position appliques uniquement aux evenements nouvellement
  // inseres.
  for (const delta of positionDeltas(event)) {
    if (delta.kind === 'units') {
      const amount = new Prisma.Decimal(delta.unitsDelta.toString());
      await prisma.userPosition.upsert({
        where: { tranche_address: { tranche: delta.tranche, address: delta.address } },
        create: { tranche: delta.tranche, address: delta.address, units: amount },
        update: { units: { increment: amount } },
      });
    } else if (delta.kind === 'subscription') {
      const tranche = await resolveTranche({ deal: delta.dealContractId }, delta.classIndex);
      if (!tranche) continue;
      const amount = new Prisma.Decimal(delta.subscribedDelta.toString());
      await prisma.userPosition.upsert({
        where: { tranche_address: { tranche, address: delta.address } },
        create: { tranche, address: delta.address, units: 0, subscribed: amount },
        update: { subscribed: { increment: amount } },
      });
    } else {
      const tranche = await resolveTranche({ agent: delta.agentContractId }, delta.classIndex);
      if (!tranche) continue;
      await prisma.userPosition.upsert({
        where: { tranche_address: { tranche, address: delta.address } },
        create: {
          tranche,
          address: delta.address,
          units: 0,
          interestReceived: new Prisma.Decimal(delta.interestDelta.toString()),
          principalReceived: new Prisma.Decimal(delta.principalDelta.toString()),
        },
        update: {
          interestReceived: { increment: new Prisma.Decimal(delta.interestDelta.toString()) },
          principalReceived: { increment: new Prisma.Decimal(delta.principalDelta.toString()) },
        },
      });
    }
  }
  return true;
}
