import { Prisma } from './generated/prisma/client.js';
import { readContract, latestLedger } from './stellar.js';
import { prisma } from './db.js';

interface DealTarget {
  dealContractId: string;
  /// Note-token contract of each registered class, with its on-chain class
  /// index (0..n-1, senior first).
  tranches: { classIndex: number; contractId: string }[];
}

/// The terms of one class in `get_config`. A deal of the earlier code has no
/// floor field: its floating rate has a floor of 0 on the all-in rate.
export interface ClassTermsView {
  rate: [string, bigint];
  total_notes: bigint;
  /// Floor of the all-in rate, in 0.001 % units. Null: no floor.
  floor?: bigint | null;
  /// Floor of the index before the spread, in 0.001 % units. Null: no floor.
  index_floor?: bigint | null;
}

interface DealConfigView {
  oracle: string;
  classes: ClassTermsView[];
}

/// A rate figure of the contract as a bigint, or null when it is absent.
function rateUnits(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

/// The all-in annual rate of a class, in 0.001 % units.
/// - Fixed: the rate.
/// - Floating: the fixing, not below the index floor, plus the spread. Then
///   not below the all-in floor. A rate below 0 gives no interest, so the
///   result is never below 0. With no fixing, the result is 0.
/// The result is always a whole number: never NaN.
export function couponRateUnits(terms: ClassTermsView, fixing: bigint | null): number {
  const [kind, rawValue] = terms.rate;
  const value = rateUnits(rawValue);
  if (value === null) return 0;
  if (kind === 'Fixed') return Number(value);
  const index = rateUnits(fixing);
  if (index === null) return 0;
  const indexFloor = rateUnits(terms.index_floor);
  const flooredIndex = indexFloor !== null && index < indexFloor ? indexFloor : index;
  const floor = rateUnits(terms.floor);
  const sum = flooredIndex + value;
  const allIn = floor !== null && sum < floor ? floor : sum;
  return allIn > 0n ? Number(allIn) : 0;
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

  // EURIBOR 1M fixing for the floating classes (see `couponRateUnits`); the
  // fixed classes carry their rate directly.
  let fixing: bigint | null = null;
  const needsFixing = config.classes.some((c) => c.rate[0] === 'Floating');
  if (needsFixing) {
    const price = (await readContract(config.oracle, 'lastprice')) as { price: bigint } | null;
    fixing = price?.price ?? null;
  }

  for (const { classIndex, contractId } of target.tranches) {
    const terms = config.classes[classIndex];
    if (!terms) continue;
    const coupon = couponRateUnits(terms, fixing);

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
        couponRateUnits: coupon,
        paidInterestCum: new Prisma.Decimal(interestCum.toString()),
        paidPrincipalCum: new Prisma.Decimal(principalCum.toString()),
      },
    });
  }
  log?.info(
    `[snapshot ${target.dealContractId.slice(0, 8)}] outstanding=${outstanding.join('/')} ledger=${ledger}`,
  );
}
