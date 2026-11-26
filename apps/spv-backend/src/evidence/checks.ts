import { formatUnits } from '../deals/amounts.js';
import { initialNotes, itemSchema, type OnChainItem, type OnChainRank } from '../deals/onchain.js';
import {
  initialState,
  requiredReserve,
  runPeriod,
  type DealPhase,
  type EngineLine,
  type EngineState,
  type Settlement,
} from '../waterfall/engine.js';
import {
  asBigInt,
  asNumber,
  eventsOf,
  inChainOrder,
  type ChainEvent,
  type Evidence,
} from './model.js';

/**
 * The checks of the evidence of one deal. Each check reads the events and
 * the snapshot only, and gives PASS, FAIL or SKIP with a reason.
 *
 * - B1: the deal runs the same contract code as the deals to compare.
 * - R1: the admin, the servicer and the reporter are three addresses.
 * - L1: the closing is a delivery versus payment.
 * - C1 to C8: each payment date, from the events alone: the periods are
 *   complete, the lines follow the configured order, each line is in its
 *   bounds, the cash is conserved, the balance covers the ledgers, the
 *   periods follow each other, the earlier events agree with the lines, and
 *   a replay with the copy of the engine gives the same lines.
 * - H1 to H4: each noteholder was served, and its cumulative counters in
 *   the paying agent equal the sum of its payment events.
 * - L2: a matured deal has empty ledgers.
 */
export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}

/** One payment date, read from the events of its transaction. */
export interface PeriodEvidence {
  period: number;
  txHash: string;
  ledger: number;
  /** The close time of the ledger, in seconds. 0 when it is not known. */
  closedAt: number;
  enforced: boolean;
  lines: EngineLine[];
  settled: Settlement;
  /** The triggers that the period published. */
  breached: string[];
  /** The recipients whose payout was parked. */
  parked: string[];
}

function sameTransaction(events: readonly ChainEvent[], txHash: string): ChainEvent[] {
  return events.filter((event) => event.txHash === txHash);
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

/** The payment dates of the deal, in period order. */
export function periodsOf(evidence: Evidence): PeriodEvidence[] {
  const { deal } = evidence.snapshot;
  const events = inChainOrder(evidence.events);
  const periods = eventsOf(events, deal, 'period_settled').map((settledEvent): PeriodEvidence => {
    const inTransaction = sameTransaction(events, settledEvent.txHash).filter((event) => event.contractId === deal);
    const [collections, reserveIn, carryIn, drawn, paidOut, reserve, carry, owed, balance, surplus] =
      settledEvent.data.map(asBigInt);
    const rankLines = inTransaction.find((event) => event.type === 'rank_lines');
    const rawLines = (rankLines?.data[1] ?? []) as unknown[][];
    return {
      period: asNumber(settledEvent.topics[0]),
      txHash: settledEvent.txHash,
      ledger: settledEvent.ledger,
      closedAt: settledEvent.closedAt ?? 0,
      enforced: rankLines?.data[0] === true,
      lines: rawLines.map(([rank, item, due, paid, dust]) => ({
        rank: String(rank),
        item: itemSchema.parse(item),
        due: asBigInt(due),
        paid: asBigInt(paid),
        dust: asBigInt(dust),
      })),
      settled: {
        collections: collections as bigint,
        reserveIn: reserveIn as bigint,
        carryIn: carryIn as bigint,
        drawn: drawn as bigint,
        paidOut: paidOut as bigint,
        reserve: reserve as bigint,
        carry: carry as bigint,
        owed: owed as bigint,
        balance: balance as bigint,
        surplus: surplus as bigint,
      },
      breached: inTransaction.filter((event) => event.type === 'trigger_breached').map((event) => String(event.topics[0])),
      parked: inTransaction.filter((event) => event.type === 'payout_parked').map((event) => String(event.topics[0])),
    };
  });
  return periods.sort((left, right) => left.period - right.period);
}

function itemKey(item: OnChainItem): string {
  switch (item.kind) {
    case 'fee':
      return `fee ${item.index}`;
    case 'interest':
      return `interest ${item.class}`;
    case 'principal':
      return `principal ${item.class}`;
    default:
      return item.kind;
  }
}

/** True when the lines are in the order of the configured ranks. */
function followsOrder(lines: readonly EngineLine[], order: readonly OnChainRank[]): boolean {
  const places = order.flatMap((entry) => entry.items.map((item) => `${entry.id}|${itemKey(item)}`));
  let next = 0;
  for (const line of lines) {
    const place = places.indexOf(`${line.rank}|${itemKey(line.item)}`, next);
    if (place < 0) return false;
    next = place + 1;
  }
  return true;
}

function sameLines(left: readonly EngineLine[], right: readonly EngineLine[]): boolean {
  return (
    left.length === right.length &&
    left.every((line, index) => {
      const other = right[index] as EngineLine;
      return (
        line.rank === other.rank &&
        itemKey(line.item) === itemKey(other.item) &&
        line.due === other.due &&
        line.paid === other.paid &&
        line.dust === other.dust
      );
    })
  );
}

interface Outcome {
  status: CheckStatus;
  detail: string;
}

const pass = (detail: string): Outcome => ({ status: 'pass', detail });
const fail = (detail: string): Outcome => ({ status: 'fail', detail });
const skip = (detail: string): Outcome => ({ status: 'skip', detail });

/** PASS when no period has a problem. A problem names its period. */
function eachPeriod(
  periods: readonly PeriodEvidence[],
  problemOf: (period: PeriodEvidence, index: number) => string | null,
  passDetail: string,
): Outcome {
  if (periods.length === 0) return skip('The event window has no payment date.');
  const problems = periods
    .map((period, index) => {
      const problem = problemOf(period, index);
      return problem === null ? null : `period ${period.period}: ${problem}`;
    })
    .filter((problem): problem is string => problem !== null);
  return problems.length === 0 ? pass(passDetail) : fail(problems.join('; '));
}

/** The fixing of each period: the last `rate_set` before the payment date. */
function fixingOf(evidence: Evidence, period: PeriodEvidence): bigint | null {
  const override = evidence.fixings[period.period];
  if (override !== undefined) return override;
  const { oracle } = evidence.snapshot.config;
  const before = inChainOrder(eventsOf(evidence.events, oracle, 'rate_set')).filter(
    (event) => event.ledger <= period.ledger,
  );
  const last = before.at(-1);
  if (last) return asBigInt(last.data[0]);
  // The fixing was published before the event window: the oracle keeps its
  // last fixings with their time.
  if (period.closedAt === 0) return null;
  const kept = evidence.snapshot.fixingHistory.filter((fixing) => fixing.timestamp <= BigInt(period.closedAt));
  return kept.at(-1)?.price ?? null;
}

/** Replays each payment date with the copy of the engine. */
function replay(evidence: Evidence, periods: readonly PeriodEvidence[]): Outcome {
  const { snapshot } = evidence;
  const { config, deal } = snapshot;
  if (periods.length === 0) return skip('The event window has no payment date.');
  if (periods[0]?.period !== 1) return skip('Period 1 is outside the event window: a replay starts at the closing.');
  const floating = config.classes.some((terms) => terms.rate.kind === 'floating');
  const enforcedAt = eventsOf(evidence.events, deal, 'enforced').map((event) => asNumber(event.data[0]))[0];
  let state: EngineState = initialState(config);
  const problems: string[] = [];
  for (const period of periods) {
    const phase: DealPhase = enforcedAt !== undefined && period.period >= enforcedAt ? 'Enforced' : 'Amortizing';
    const fixing = floating ? fixingOf(evidence, period) : null;
    if (floating && fixing === null) {
      return skip(`No fixing for period ${period.period} in the event window. Give --fixing ${period.period}=<units>.`);
    }
    const result = runPeriod(config, { ...state, phase }, {
      collections: period.settled.collections,
      fixing,
      parked: period.parked,
    });
    const settled = result.settled;
    const expected = period.settled;
    if (!sameLines(result.lines, period.lines)) problems.push(`period ${period.period}: the lines differ`);
    for (const field of ['reserveIn', 'carryIn', 'drawn', 'paidOut', 'reserve', 'carry', 'owed'] as const) {
      if (settled[field] !== expected[field]) {
        problems.push(`period ${period.period}: ${field} is ${expected[field]} in the event and ${settled[field]} in the replay`);
      }
    }
    if (result.breached.join(',') !== period.breached.join(',')) {
      problems.push(`period ${period.period}: the triggers differ`);
    }
    // The next period opens with the ledgers of the replay. Its balance is
    // the balance of the event: the network can hold a surplus that came
    // from outside the deal. The replay does not compare the balance.
    state = { ...result.closing, balance: expected.balance };
  }
  return problems.length === 0
    ? pass(`${periods.length} payment date(s): the copy of the engine gives the same lines and the same settlement.`)
    : fail(problems.join('; '));
}

/** Every check of the evidence. */
export function runChecks(evidence: Evidence): Check[] {
  const { snapshot, events } = evidence;
  const { config, deal, payingAgent } = snapshot;
  const units = (value: bigint): string => formatUnits(value, snapshot.asset.decimals);
  const periods = periodsOf(evidence);
  const checks: Check[] = [];
  const add = (id: string, title: string, outcome: Outcome): void => {
    checks.push({ id, title, ...outcome });
  };

  // B1 - one binary.
  if (snapshot.compare.length === 0) {
    add('B1', 'Same contract code as the other deals', skip('No deal to compare (--compare-code).'));
  } else {
    const different = snapshot.compare.filter(
      (other) =>
        other.code.deal !== snapshot.code.deal ||
        other.code.note !== snapshot.code.note ||
        other.code.agent !== snapshot.code.agent,
    );
    add(
      'B1',
      'Same contract code as the other deals',
      different.length === 0
        ? pass(`abs-deal ${snapshot.code.deal}, the same as ${snapshot.compare.map((other) => other.deal).join(', ')}.`)
        : fail(`Another code in: ${different.map((other) => other.deal).join(', ')}.`),
    );
  }

  // R1 - three roles.
  const roles = [config.admin, config.servicer, ...(snapshot.reporter === null ? [] : [snapshot.reporter])];
  add(
    'R1',
    'The admin, the servicer and the reporter are separate addresses',
    new Set(roles).size === roles.length
      ? pass(
          snapshot.reporter === null
            ? 'Admin and servicer differ. The deal has fixed rates only: it reads no oracle.'
            : 'Three different addresses.',
        )
      : fail('One address holds two roles.'),
  );

  // L1 - closing DvP.
  const closed = eventsOf(events, deal, 'deal_closed')[0];
  if (!closed) {
    add('L1', 'Closing: delivery versus payment', skip('The closing is outside the event window.'));
  } else {
    const face = initialNotes(config);
    const problems: string[] = [];
    if (asBigInt(closed.data[0]) !== face) problems.push(`the proceeds are ${units(asBigInt(closed.data[0]))}, not the face ${units(face)}`);
    const required = requiredReserve(config, false, face);
    if (asBigInt(closed.data[1]) !== required) problems.push(`the reserve is ${units(asBigInt(closed.data[1]))}, not ${units(required)}`);
    snapshot.notes.forEach((note, classIndex) => {
      const issued = sum(
        eventsOf(events, note, 'issue')
          .filter((event) => event.txHash === closed.txHash)
          .map((event) => asBigInt(event.data[0])),
      );
      const expected = config.classes[classIndex]?.totalNotes ?? 0n;
      if (issued !== expected) problems.push(`class ${classIndex}: ${issued} notes issued, not ${expected}`);
    });
    add(
      'L1',
      'Closing: delivery versus payment',
      problems.length === 0
        ? pass(`In one transaction: ${units(face)} to the seller, ${units(required)} to the reserve, every note issued.`)
        : fail(problems.join('; ')),
    );
  }

  // C1 - complete periods.
  const expectedCount = snapshot.nextPeriod - 1;
  const numbers = periods.map((period) => period.period);
  const contiguous = numbers.every((number, index) => number === index + 1);
  add(
    'C1',
    'One settlement event for each payment date',
    contiguous && numbers.length === expectedCount
      ? pass(`${expectedCount} payment date(s), each with its period_settled and rank_lines events.`)
      : fail(`The deal ran ${expectedCount} period(s). The event window has the periods ${numbers.join(', ') || 'none'}.`),
  );

  // C2 - the configured order.
  add(
    'C2',
    'The rank lines follow the configured order',
    eachPeriod(
      periods,
      (period) => (followsOrder(period.lines, period.enforced ? config.enforced : config.normal) ? null : 'a line is out of order'),
      'Each line is a rank of the configuration, in its order.',
    ),
  );

  // C3 - bounds.
  add(
    'C3',
    'Each line pays at most its due',
    eachPeriod(
      periods,
      (period) => {
        const bad = period.lines.find((line) => line.paid < 0n || line.dust < 0n || line.paid + line.dust > line.due);
        return bad ? `the line ${bad.rank} is out of its bounds` : null;
      },
      'For each line: 0 <= paid, and paid + dust <= due.',
    ),
  );

  // C4 - conservation.
  add(
    'C4',
    'Conservation: collections + reserve + carry in = paid out + reserve + carry',
    eachPeriod(
      periods,
      (period) => {
        const settled = period.settled;
        if (settled.collections + settled.reserveIn + settled.carryIn !== settled.paidOut + settled.reserve + settled.carry) {
          return 'the settlement does not balance';
        }
        // The cash that left the ledgers, from the other events of the transaction.
        const inTransaction = sameTransaction(events, period.txHash);
        const amounts = (contractId: string, type: string, position: number): bigint =>
          sum(eventsOf(inTransaction, contractId, type).map((event) => asBigInt(event.data[position])));
        const funded = sum(
          eventsOf(inTransaction, payingAgent, 'period_funded').map((event) => asBigInt(event.data[1]) + asBigInt(event.data[2])),
        );
        const out =
          amounts(deal, 'fees_paid', 0) + amounts(deal, 'payout_parked', 2) + funded + amounts(deal, 'residual_paid', 0);
        return out === settled.paidOut + settled.surplus
          ? null
          : `the payments of the transaction are ${units(out)}, and paid_out + surplus is ${units(settled.paidOut + settled.surplus)}`;
      },
      'In each period_settled event, and against the payments of the same transaction.',
    ),
  );

  // C5 - the balance invariant.
  const live = snapshot.balance >= snapshot.reserve + snapshot.carry + snapshot.owedTotal;
  const invariant = eachPeriod(
    periods,
    (period) => {
      const settled = period.settled;
      return settled.balance >= settled.reserve + settled.carry + settled.owed ? null : 'the balance is below the ledgers';
    },
    `In each period_settled event. Now: balance ${units(snapshot.balance)}, reserve ${units(snapshot.reserve)}, carry ${units(snapshot.carry)}, owed ${units(snapshot.owedTotal)}.`,
  );
  add(
    'C5',
    'Balance invariant: balance >= reserve + carry + amounts owed',
    live ? invariant : fail('The balance of the deal is below its ledgers now.'),
  );

  // C6 - continuity.
  add(
    'C6',
    'Each period opens with the ledgers of the period before',
    eachPeriod(
      periods,
      (period, index) => {
        const previous = periods[index - 1];
        if (previous) {
          if (period.settled.reserveIn !== previous.settled.reserve) return 'the opening reserve is not the closing reserve of the period before';
          if (period.settled.carryIn !== previous.settled.carry) return 'the opening carry is not the closing carry of the period before';
        } else if (period.period === 1 && closed) {
          if (period.settled.reserveIn !== asBigInt(closed.data[1])) return 'the opening reserve is not the reserve of the closing';
          if (period.settled.carryIn !== 0n) return 'the first period opens with a carry';
        }
        const distribution = eventsOf(sameTransaction(events, period.txHash), deal, 'distribution')[0];
        if (!distribution || asBigInt(distribution.data[0]) !== period.settled.collections) {
          return 'the distribution event has other collections';
        }
        if (index === periods.length - 1) {
          if (period.settled.reserve !== snapshot.reserve || period.settled.carry !== snapshot.carry) {
            return 'the ledgers of the deal now are not the ledgers of the last settlement';
          }
        }
        return null;
      },
      'Reserve and carry chain from the closing to the ledgers of the deal now.',
    ),
  );

  // C7 - the earlier events agree with the lines.
  add(
    'C7',
    'The interest, principal and paying agent events agree with the rank lines',
    eachPeriod(
      periods,
      (period) => {
        const inTransaction = sameTransaction(events, period.txHash);
        for (let classIndex = 0; classIndex < config.classes.length; classIndex++) {
          const lineOf = (kind: 'interest' | 'principal'): EngineLine | undefined =>
            period.lines.find((line) => line.item.kind === kind && line.item.class === classIndex);
          const interest = eventsOf(inTransaction, deal, 'interest_paid').find((event) => asNumber(event.topics[0]) === classIndex);
          const interestLine = lineOf('interest');
          if (interest && (!interestLine || asBigInt(interest.data[1]) !== interestLine.due || asBigInt(interest.data[2]) !== interestLine.paid)) {
            return `the interest_paid event of class ${classIndex} differs from its line`;
          }
          const funded = eventsOf(inTransaction, payingAgent, 'period_funded').find((event) => asNumber(event.data[0]) === classIndex);
          if (!funded) return `no period_funded event for class ${classIndex}`;
          if (asBigInt(funded.data[1]) !== (interestLine?.paid ?? 0n)) return `the paying agent got another interest for class ${classIndex}`;
          if (asBigInt(funded.data[2]) !== (lineOf('principal')?.paid ?? 0n)) return `the paying agent got another principal for class ${classIndex}`;
        }
        return null;
      },
      'For each class: interest_paid and period_funded carry the amounts of the lines.',
    ),
  );

  // C8 - replay.
  add('C8', 'A replay with the copy of the engine gives the same lines', replay(evidence, periods));

  // H1 - cumulative counters.
  const holderProblems: string[] = [];
  for (const row of snapshot.holders) {
    const mine = (type: string): ChainEvent[] =>
      eventsOf(events, payingAgent, type).filter((event) => String(event.topics[0]) === row.holder);
    const paid = mine('holder_paid').filter((event) => asNumber(event.data[1]) === row.class);
    const claimed = mine('claimed').filter((event) => asNumber(event.data[0]) === row.class);
    const interest = sum(paid.map((event) => asBigInt(event.data[2]))) + sum(claimed.map((event) => asBigInt(event.data[1])));
    const principal = sum(paid.map((event) => asBigInt(event.data[3]))) + sum(claimed.map((event) => asBigInt(event.data[2])));
    if (interest !== row.interestPaid || principal !== row.principalPaid) {
      holderProblems.push(
        `class ${row.class} ${row.holder}: counters ${units(row.interestPaid)} + ${units(row.principalPaid)}, events ${units(interest)} + ${units(principal)}`,
      );
    }
  }
  const windowIsWhole = periods.length > 0 && periods[0]?.period === 1;
  add(
    'H1',
    'Each holder: cumulative counters = holder_paid + claimed events',
    snapshot.holders.length === 0
      ? skip('The deal has no holder yet.')
      : !windowIsWhole
        ? skip('Period 1 is outside the event window: the sums are not complete.')
        : holderProblems.length === 0
          ? pass(`${snapshot.holders.length} holder position(s): interest and principal counters equal the events.`)
          : fail(holderProblems.join('; ')),
  );

  // H2 - failed pushes.
  const failedPushes = sum(eventsOf(events, payingAgent, 'push_failed').map((event) => asBigInt(event.data[2])));
  const claims = sum(eventsOf(events, payingAgent, 'claimed').map((event) => asBigInt(event.data[1]) + asBigInt(event.data[2])));
  const openClaims = sum(snapshot.holders.map((row) => row.claimableInterest + row.claimablePrincipal));
  add(
    'H2',
    'Each failed push is claimed or waits for its holder',
    !windowIsWhole
      ? skip('Period 1 is outside the event window.')
      : failedPushes === claims + openClaims
        ? pass(`Failed pushes ${units(failedPushes)} = claimed ${units(claims)} + open ${units(openClaims)}.`)
        : fail(`Failed pushes ${units(failedPushes)}, claimed ${units(claims)}, open ${units(openClaims)}.`),
  );

  // H3 - every batch.
  const funded = eventsOf(events, payingAgent, 'period_funded');
  const complete = new Set(
    eventsOf(events, payingAgent, 'batch_done')
      .filter((event) => event.data[2] === true)
      .map((event) => `${asNumber(event.topics[0])}/${asNumber(event.data[0])}`),
  );
  const notPushed = funded
    .map((event) => `${asNumber(event.topics[0])}/${asNumber(event.data[0])}`)
    .filter((key) => !complete.has(key));
  add(
    'H3',
    'Every holder of every class was served at each payment date',
    funded.length === 0
      ? skip('The event window has no payment date.')
      : notPushed.length === 0
        ? pass(`${funded.length} class payment(s): each one has a complete batch_done event.`)
        : fail(`Not pushed to the end (period/class): ${notPushed.join(', ')}.`),
  );

  // H4 - the paying agent holds only what waits.
  const waiting = openClaims + sum(snapshot.dust);
  add(
    'H4',
    'The paying agent holds only the open claims and the rounding remainder',
    notPushed.length > 0
      ? skip('A batch is not complete: the paying agent still holds its cash.')
      : snapshot.agentBalance === waiting
        ? pass(`Balance ${units(snapshot.agentBalance)} = open claims ${units(openClaims)} + remainder ${units(sum(snapshot.dust))}.`)
        : fail(`Balance ${units(snapshot.agentBalance)}, open claims ${units(openClaims)}, remainder ${units(sum(snapshot.dust))}.`),
  );

  // L2 - maturity.
  if (snapshot.state !== 'Matured') {
    add('L2', 'A matured deal has empty ledgers', skip(`The deal is ${snapshot.state}.`));
  } else {
    const empty =
      snapshot.reserve === 0n &&
      snapshot.carry === 0n &&
      snapshot.perNote.every((value) => value === 0n) &&
      snapshot.shortfall.every((value) => value === 0n) &&
      snapshot.balance === snapshot.owedTotal;
    add(
      'L2',
      'A matured deal has empty ledgers',
      empty
        ? pass('Every class is repaid, no interest is unpaid, reserve and carry are 0, and the balance is the amounts owed.')
        : fail('A ledger of the matured deal is not empty.'),
    );
  }
  return checks;
}

/** True when no check failed. */
export function allPassed(checks: readonly Check[]): boolean {
  return checks.every((check) => check.status !== 'fail');
}
