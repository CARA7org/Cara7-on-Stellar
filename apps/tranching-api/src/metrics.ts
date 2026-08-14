import { prisma } from './db.js';
import { readContract } from './stellar.js';

const DAY_MS = 86_400_000;
const RATE_SCALE = 100_000;
export const FACTOR_SCALE = 10_000_000;

/// Deal phase, read on-chain with a small cache (the state machine only moves
/// on close/set_enforced/maturity).
const phaseCache = new Map<string, { phase: string; at: number }>();
const PHASE_TTL_MS = 30_000;

export async function dealPhase(dealContractId: string | null): Promise<string> {
  if (!dealContractId) return 'FUNDING';
  const cached = phaseCache.get(dealContractId);
  if (cached && Date.now() - cached.at < PHASE_TTL_MS) return cached.phase;
  try {
    const state = (await readContract(dealContractId, 'get_state')) as string;
    const phase = String(state).toUpperCase();
    phaseCache.set(dealContractId, { phase, at: Date.now() });
    return phase;
  } catch {
    return cached?.phase ?? 'FUNDING';
  }
}

/// Investor metrics of a NOTE (no NAV, no share price any more): factor,
/// outstanding, current coupon, accrued interest, paid totals, next due date.
export async function trancheStats(contractId: string): Promise<Record<string, unknown> | null> {
  const latest = await prisma.trancheSnapshot.findFirst({
    where: { contractId },
    orderBy: { ts: 'desc' },
  });
  const tranche = await prisma.tranche.findUnique({
    where: { contractId },
    include: { deal: true },
  });
  if (!tranche) return null;

  const phase = await dealPhase(tranche.deal.dealContractId);
  const originalFace = tranche.originalFace.toString();
  if (!latest) {
    // No snapshot yet (deal still in funding): nominal state.
    return {
      trancheId: contractId,
      phase,
      originalFace,
      outstanding: phase === 'FUNDING' ? '0' : originalFace,
      noteFactorPct: phase === 'FUNDING' ? 0 : 100,
      coupon: null,
      accrued: null,
      cumulative: { interestPaid: '0', principalPaid: '0' },
      lastDistribution: null,
      nextPayment: null,
      ledger: null,
      ts: null,
    };
  }

  const noteFactorPct = latest.noteFactor / (FACTOR_SCALE / 100);
  const redeemed = latest.noteFactor === 0;
  const allInPct = latest.couponRateUnits / 1_000;
  const periodDays = tranche.deal.periodDays;

  // Last indexed distribution of the deal (`distribution` event).
  const lastDistributionEvent = tranche.deal.dealContractId
    ? await prisma.stellarEvent.findFirst({
        where: { contractId: tranche.deal.dealContractId, type: 'distribution' },
        orderBy: { id: 'desc' },
        select: { ts: true, topic: true },
      })
    : null;
  const anchor = lastDistributionEvent?.ts ?? tranche.deal.closedAt ?? latest.ts;
  const accruedDays = Math.max(0, (Date.now() - anchor.getTime()) / DAY_MS);
  const outstandingNumber = Number(latest.outstanding);
  const accruedInterest = Math.floor(
    (outstandingNumber * latest.couponRateUnits * Math.min(accruedDays, periodDays)) /
      360 /
      RATE_SCALE,
  );
  const estimatedInterest = Math.floor(
    (outstandingNumber * latest.couponRateUnits * periodDays) / 360 / RATE_SCALE,
  );

  return {
    trancheId: contractId,
    phase: redeemed ? 'REDEEMED' : phase,
    originalFace,
    outstanding: latest.outstanding.toString(),
    noteFactorPct,
    coupon: {
      allInPct,
      rateUnits: latest.couponRateUnits,
      pricing:
        tranche.seniority === 'SENIOR'
          ? 'EURIBOR 1M + 0.60% (floor 0%)'
          : `${allInPct.toFixed(2)}% fixed`,
    },
    accrued: {
      days: Number(Math.min(accruedDays, periodDays).toFixed(2)),
      periodDays,
      interest: String(accruedInterest),
    },
    cumulative: {
      interestPaid: latest.paidInterestCum.toString(),
      principalPaid: latest.paidPrincipalCum.toString(),
    },
    lastDistribution: lastDistributionEvent
      ? {
          ts: lastDistributionEvent.ts,
          period: Number((lastDistributionEvent.topic as unknown[])[1] ?? 0),
        }
      : null,
    nextPayment: redeemed
      ? null
      : {
          dueAt: new Date(anchor.getTime() + periodDays * DAY_MS),
          estimatedInterest: String(estimatedInterest),
        },
    ledger: latest.ledger,
    ts: latest.ts,
  };
}

export interface TrancheHistoryPoint {
  ts: Date;
  ledger: number;
  outstanding: string;
  noteFactorPct: number;
  paidInterestCum: string;
  paidPrincipalCum: string;
}

export async function trancheHistory(
  contractId: string,
  range: string,
): Promise<TrancheHistoryPoint[]> {
  const days =
    ({ '7d': 7, '30d': 30, '60d': 60, '90d': 90, all: 36500 } as Record<string, number>)[range] ??
    30;
  const since = new Date(Date.now() - days * DAY_MS);
  const rows = await prisma.trancheSnapshot.findMany({
    where: { contractId, ts: { gte: since } },
    orderBy: { ts: 'asc' },
  });
  return rows.map((row) => ({
    ts: row.ts,
    ledger: row.ledger,
    outstanding: row.outstanding.toString(),
    noteFactorPct: row.noteFactor / (FACTOR_SCALE / 100),
    paidInterestCum: row.paidInterestCum.toString(),
    paidPrincipalCum: row.paidPrincipalCum.toString(),
  }));
}

/// Positions of an address: the counters are maintained by the ingestion (no
/// event replay per request). The remaining claim of a position =
/// notes x denomination x factor.
export async function userPositions(address: string): Promise<Record<string, unknown>[]> {
  const rows = await prisma.userPosition.findMany({ where: { address } });
  return Promise.all(
    rows.map(async (row) => {
      const latest = await prisma.trancheSnapshot.findFirst({
        where: { contractId: row.tranche },
        orderBy: { ts: 'desc' },
      });
      const tranche = await prisma.tranche.findUnique({ where: { contractId: row.tranche } });
      const units = BigInt(row.units.toString());
      let outstandingClaim = '0';
      if (latest && tranche) {
        // The claim of the address = class outstanding x share of the notes
        // held (the sum of the positions == the number of notes issued).
        const outstanding = BigInt(latest.outstanding.toString());
        const totalUnits = await prisma.userPosition.aggregate({
          where: { tranche: row.tranche },
          _sum: { units: true },
        });
        const supply = BigInt(totalUnits._sum.units?.toString() ?? '0');
        outstandingClaim = supply > 0n ? ((outstanding * units) / supply).toString() : '0';
      }
      return {
        tranche: row.tranche,
        address: row.address,
        units: row.units.toString(),
        outstandingClaim,
        subscribed: row.subscribed.toString(),
        interestReceived: row.interestReceived.toString(),
        principalReceived: row.principalReceived.toString(),
        updatedAt: row.updatedAt,
      };
    }),
  );
}

/// Position value over time: notes held at each snapshot x outstanding per
/// note of that snapshot, plus the total received (interest + principal) to
/// date. The note timeline is replayed from issue/transfer.
export async function userPositionHistory(
  contractId: string,
  address: string,
  range: string,
): Promise<{ ts: Date; value: number; receivedCum: number }[]> {
  const snapshots = await prisma.trancheSnapshot.findMany({
    where: {
      contractId,
      ts: {
        gte: new Date(
          Date.now() -
            (({ '7d': 7, '30d': 30, '60d': 60, '90d': 90, all: 36500 } as Record<string, number>)[
              range
            ] ?? 30) *
              DAY_MS,
        ),
      },
    },
    orderBy: { ts: 'asc' },
  });
  if (snapshots.length === 0) return [];

  const tranche = await prisma.tranche.findUnique({
    where: { contractId },
    include: { deal: true },
  });
  if (!tranche) return [];

  const unitEvents = await prisma.stellarEvent.findMany({
    where: { contractId, type: { in: ['issue', 'transfer'] } },
    orderBy: { id: 'asc' },
    select: { type: true, ts: true, topic: true, data: true },
  });
  const unitDeltas: { at: number; delta: bigint }[] = [];
  for (const event of unitEvents) {
    const topic = event.topic as string[];
    const raw = event.data as unknown;
    const amount = BigInt(Array.isArray(raw) ? String(raw[0] ?? '0') : String(raw));
    const at = event.ts.getTime();
    if (event.type === 'issue' && topic[1] === address) {
      unitDeltas.push({ at, delta: amount });
    } else if (event.type === 'transfer') {
      if (topic[1] === address) unitDeltas.push({ at, delta: -amount });
      if (topic[2] === address) unitDeltas.push({ at, delta: amount });
    }
  }

  // Total received by this address on this tranche over time (holder_paid
  // + claimed of the paying agent, class resolved by seniority).
  const classIndex = ['SENIOR', 'MEZZANINE', 'JUNIOR'].indexOf(tranche.seniority);
  const paymentEvents = tranche.deal.payingAgentContractId
    ? await prisma.stellarEvent.findMany({
        where: {
          contractId: tranche.deal.payingAgentContractId,
          type: { in: ['holder_paid', 'claimed'] },
        },
        orderBy: { id: 'asc' },
        select: { type: true, ts: true, topic: true, data: true },
      })
    : [];
  const receivedDeltas: { at: number; delta: bigint }[] = [];
  for (const event of paymentEvents) {
    const topic = event.topic as string[];
    if (topic[1] !== address) continue;
    const data = event.data as string[];
    const at = event.ts.getTime();
    if (event.type === 'holder_paid' && Number(data[1]) === classIndex) {
      receivedDeltas.push({ at, delta: BigInt(data[2] ?? '0') + BigInt(data[3] ?? '0') });
    } else if (event.type === 'claimed' && Number(data[0]) === classIndex) {
      receivedDeltas.push({ at, delta: BigInt(data[1] ?? '0') + BigInt(data[2] ?? '0') });
    }
  }

  const supply = BigInt(
    (
      await prisma.userPosition.aggregate({
        where: { tranche: contractId },
        _sum: { units: true },
      })
    )._sum.units?.toString() ?? '0',
  );

  let unitIndex = 0;
  let receivedIndex = 0;
  let units = 0n;
  let received = 0n;
  return snapshots.map((snapshot) => {
    const at = snapshot.ts.getTime();
    while (unitIndex < unitDeltas.length && (unitDeltas[unitIndex]?.at ?? Infinity) <= at) {
      units += unitDeltas[unitIndex]?.delta ?? 0n;
      unitIndex++;
    }
    while (
      receivedIndex < receivedDeltas.length &&
      (receivedDeltas[receivedIndex]?.at ?? Infinity) <= at
    ) {
      received += receivedDeltas[receivedIndex]?.delta ?? 0n;
      receivedIndex++;
    }
    const outstanding = BigInt(snapshot.outstanding.toString());
    const value = supply > 0n ? Number((outstanding * units) / supply) : 0;
    return { ts: snapshot.ts, value, receivedCum: Number(received) };
  });
}
