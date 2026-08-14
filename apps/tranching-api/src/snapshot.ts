import { Prisma } from './generated/prisma/client.js';
import { readContract, latestLedger } from './stellar.js';
import { prisma } from './db.js';

interface DealTarget {
  dealContractId: string;
  /// Note-token contract ids in on-chain class order (SENIOR, MEZZANINE, JUNIOR).
  trancheContractIds: string[];
}

interface DealConfigView {
  oracle: string;
  classes: { rate: [string, bigint]; total_notes: bigint }[];
}

/// Read the live state of the deal (outstanding, note factors, all-in coupons)
/// through RPC and persist ONE snapshot per tranche. The paid totals come from
/// the interest_paid/principal_paid events already ingested (DB, not RPC).
export async function takeDealSnapshot(
  target: DealTarget,
  log?: { info: (message: string) => void },
): Promise<void> {
  const ledger = await latestLedger();
  const [outstanding, factors, config] = await Promise.all([
    readContract(target.dealContractId, 'get_outstanding') as Promise<bigint[]>,
    readContract(target.dealContractId, 'get_note_factors') as Promise<bigint[]>,
    readContract(target.dealContractId, 'get_config') as Promise<DealConfigView>,
  ]);

  // EURIBOR 1M fixing for the floating classes (all-in = fixing + spread,
  // floor 0); the fixed classes carry their rate directly.
  let fixing: bigint | null = null;
  const needsFixing = config.classes.some((c) => c.rate[0] === 'Floating');
  if (needsFixing) {
    const price = (await readContract(config.oracle, 'lastprice')) as { price: bigint } | null;
    fixing = price?.price ?? null;
  }

  for (let classIndex = 0; classIndex < target.trancheContractIds.length; classIndex++) {
    const contractId = target.trancheContractIds[classIndex];
    if (!contractId) continue;
    const terms = config.classes[classIndex];
    if (!terms) continue;
    const [kind, value] = terms.rate;
    const couponRateUnits =
      kind === 'Fixed'
        ? Number(value)
        : fixing !== null
          ? Math.max(0, Number(fixing + value))
          : 0;

    // Totals per class from the deal events (topics [type, class]).
    const paid = await prisma.stellarEvent.findMany({
      where: {
        contractId: target.dealContractId,
        type: { in: ['interest_paid', 'principal_paid'] },
      },
      select: { type: true, topic: true, data: true },
    });
    let interestCum = 0n;
    let principalCum = 0n;
    for (const event of paid) {
      const topic = event.topic as (string | number)[];
      if (Number(topic[1]) !== classIndex) continue;
      const data = event.data as string[];
      if (event.type === 'interest_paid') {
        // data [period, due, paid, shortfall, dust]
        interestCum += BigInt(data[2] ?? '0');
      } else {
        // data [period, paid, per_note, outstanding_after]
        principalCum += BigInt(data[1] ?? '0');
      }
    }

    await prisma.trancheSnapshot.create({
      data: {
        contractId,
        ledger,
        outstanding: new Prisma.Decimal((outstanding[classIndex] ?? 0n).toString()),
        noteFactor: Number(factors[classIndex] ?? 0n),
        couponRateUnits,
        paidInterestCum: new Prisma.Decimal(interestCum.toString()),
        paidPrincipalCum: new Prisma.Decimal(principalCum.toString()),
      },
    });
  }
  log?.info(
    `[snapshot ${target.dealContractId.slice(0, 8)}] outstanding=${outstanding.join('/')} ledger=${ledger}`,
  );
}
