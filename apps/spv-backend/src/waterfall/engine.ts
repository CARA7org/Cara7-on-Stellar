import {
  FACTOR_SCALE,
  RATE_SCALE,
  hasFloatingClass,
  initialNotes,
  type OnChainClass,
  type OnChainCond,
  type OnChainDealConfig,
  type OnChainItem,
  type RankAlloc,
  type TriggerOp,
} from '../deals/onchain.js';

/**
 * A copy of the rank engine of the abs-deal contract: one payment date of a
 * configured priority of payments.
 *
 * The contract is the authority (contracts/abs-deal/src/engine.rs, and the
 * end of `distribute` in lib.rs). This copy is a second calculation of the
 * same rules, in another language:
 *
 * - the preview shows a payment date before the servicer signs it;
 * - the evidence tool replays each payment date and compares the result
 *   with the events of the contract.
 *
 * The module is pure and uses bigint only. A test runs it on the vectors of
 * the contract tests (contracts/abs-deal/vectors): each line, each
 * settlement and each closing ledger must be equal.
 */

const DAY_COUNT_BASE = 360n;

export type DealPhase = 'Amortizing' | 'Enforced' | 'Matured';

/** The ledgers of a deal between two payment dates. */
export interface EngineState {
  phase: DealPhase;
  reserve: bigint;
  carry: bigint;
  /** The parked payouts that are not claimed yet. */
  owed: bigint;
  /** The asset balance of the deal contract. */
  balance: bigint;
  /** Outstanding per note, for each class. */
  perNote: bigint[];
  /** Unpaid interest, for each class. */
  shortfall: bigint[];
  /** The stored trigger flags, in the order of the configuration. */
  triggers: boolean[];
}

export interface PeriodInput {
  collections: bigint;
  /** The fixing of the oracle in rate units. Null when no class floats. */
  fixing: bigint | null;
  /** The recipients whose payout fails (a frozen account): their cash is parked. */
  parked?: readonly string[];
}

/** One line of the `rank_lines` event. */
export interface EngineLine {
  rank: string;
  item: OnChainItem;
  due: bigint;
  paid: bigint;
  /** The per-note remainder that goes to the carry. */
  dust: bigint;
}

/** The figures of the `period_settled` event. */
export interface Settlement {
  collections: bigint;
  reserveIn: bigint;
  carryIn: bigint;
  drawn: bigint;
  paidOut: bigint;
  reserve: bigint;
  carry: bigint;
  owed: bigint;
  balance: bigint;
  surplus: bigint;
}

export interface ClassPayment {
  interest: bigint;
  principal: bigint;
  perNotePrincipal: bigint;
}

export interface PeriodResult {
  /** True when the enforced order ran. */
  enforced: boolean;
  lines: EngineLine[];
  settled: Settlement;
  /** The triggers that are set in this period and were not set before. */
  breached: string[];
  /** Interest and principal of each class, for the paying agent. */
  payments: ClassPayment[];
  /** The required reserve of the period. */
  required: bigint;
  /** The reserve cash released at the top of the period. */
  released: bigint;
  /** The available amount at the top: collections + released + carry. */
  available: bigint;
  /** The cash paid to the Seller, with the maturity sweep. */
  residual: bigint;
  matured: boolean;
  closing: EngineState;
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

/** Floor the per-note amount to `roundUnit`: the amount paid and the dust. */
export function roundPerNote(entitlement: bigint, notes: bigint, roundUnit: bigint): { paid: bigint; dust: bigint } {
  const perNote = (entitlement / notes / roundUnit) * roundUnit;
  const paid = perNote * notes;
  return { paid, dust: entitlement - paid };
}

/** Interest of one period on a nominal amount, on `daysInPeriod` / 360. */
export function accrue(nominal: bigint, annualRate: bigint, daysInPeriod: number): bigint {
  if (annualRate <= 0n || nominal <= 0n) return 0n;
  return (nominal * annualRate * BigInt(daysInPeriod)) / DAY_COUNT_BASE / RATE_SCALE;
}

/** The annual rate of a class in rate units, with its floors. */
export function classRate(terms: OnChainClass, fixing: bigint | null): bigint {
  if (terms.rate.kind === 'fixed') return terms.rate.units;
  if (fixing === null) throw new Error('A floating class needs the fixing of the oracle.');
  const index = terms.indexFloor === null ? fixing : maximum(fixing, terms.indexFloor);
  const allIn = index + terms.rate.units;
  return terms.floor === null ? allIn : maximum(allIn, terms.floor);
}

/** The required reserve for an opening balance of the notes. */
export function requiredReserve(config: OnChainDealConfig, enforced: boolean, notesOpen: bigint): bigint {
  if (enforced || notesOpen <= 0n) return 0n;
  const rule = config.reserve.required;
  if (rule.kind === 'fixed') return rule.amount;
  return maximum((notesOpen * rule.pct) / RATE_SCALE, rule.floor);
}

/** The outstanding balance of all notes. */
export function notesOutstanding(config: OnChainDealConfig, perNote: readonly bigint[]): bigint {
  return config.classes.reduce((sum, terms, index) => sum + (perNote[index] ?? 0n) * terms.totalNotes, 0n);
}

function compare(value: bigint, op: TriggerOp, threshold: bigint): boolean {
  switch (op) {
    case 'gt':
      return value > threshold;
    case 'ge':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'le':
      return value <= threshold;
  }
}

function holds(config: OnChainDealConfig, when: OnChainCond, flags: readonly boolean[]): boolean {
  if (when.kind === 'always') return true;
  const position = config.triggers.findIndex((terms) => terms.id === when.id);
  const set = position >= 0 && flags[position] === true;
  return when.kind === 'trigger' ? set : !set;
}

/** Split `available` between the dues of one rank. */
function allocate(alloc: RankAlloc, dues: readonly bigint[], available: bigint): bigint[] {
  const total = dues.reduce((sum, due) => sum + due, 0n);
  if (total <= available) return [...dues];
  if (alloc === 'sequential') {
    let left = available;
    return dues.map((due) => {
      const share = minimum(due, left);
      left -= share;
      return share;
    });
  }
  // Pari passu: in proportion to the dues, the units left to the first
  // items, each one up to its due.
  const shares = dues.map((due) => (available * due) / total);
  let given = shares.reduce((sum, share) => sum + share, 0n);
  for (let position = 0; position < shares.length && given < available; position++) {
    const add = minimum((dues[position] as bigint) - (shares[position] as bigint), available - given);
    shares[position] = (shares[position] as bigint) + add;
    given += add;
  }
  return shares;
}

/** The ledgers of a deal right after its closing. */
export function initialState(config: OnChainDealConfig): EngineState {
  const reserve = requiredReserve(config, false, initialNotes(config));
  return {
    phase: 'Amortizing',
    reserve,
    carry: 0n,
    owed: 0n,
    balance: reserve,
    perNote: config.classes.map(() => config.noteDenomination),
    shortfall: config.classes.map(() => 0n),
    triggers: config.triggers.map(() => false),
  };
}

/** Run one payment date. */
export function runPeriod(config: OnChainDealConfig, state: EngineState, input: PeriodInput): PeriodResult {
  if (state.phase === 'Matured') throw new Error('The deal is matured: it has no payment date.');
  if (input.collections < 0n) throw new Error('The collections are negative.');
  const enforced = state.phase === 'Enforced';
  const unit = config.roundUnit;
  const days = config.daysInPeriod;
  const parked = new Set(input.parked ?? []);
  const fixing = hasFloatingClass(config) ? input.fixing : null;

  // The opening balance of the notes, and the interest dues.
  const notes = config.classes.map((terms) => terms.totalNotes);
  const notesOpen = notesOutstanding(config, state.perNote);
  const perNote = [...state.perNote];
  const interestDue = config.classes.map((terms, index) => {
    const nominal = (state.perNote[index] ?? 0n) * terms.totalNotes;
    return accrue(nominal, classRate(terms, fixing), days) + (state.shortfall[index] ?? 0n);
  });
  // A due stays a shortfall until an interest line pays it.
  const shortfall = [...interestDue];
  const payments: ClassPayment[] = config.classes.map(() => ({ interest: 0n, principal: 0n, perNotePrincipal: 0n }));

  // 1. Required reserve.
  const required = requiredReserve(config, enforced, notesOpen);

  // 2. Triggers, on the opening ledgers.
  const notesInitial = initialNotes(config);
  const breached: string[] = [];
  const triggers = config.triggers.map((terms, index) => {
    let value: bigint;
    switch (terms.metric.kind) {
      case 'classFactor':
        value = ((state.perNote[terms.metric.class] ?? 0n) * FACTOR_SCALE) / config.noteDenomination;
        break;
      case 'notesFactor':
        value = notesInitial > 0n ? (notesOpen * FACTOR_SCALE) / notesInitial : 0n;
        break;
      case 'reserveShortfall':
        value = maximum(required - state.reserve, 0n);
        break;
      case 'classShortfall':
        value = state.shortfall[terms.metric.class] ?? 0n;
        break;
    }
    const stored = state.triggers[index] === true;
    const now = compare(value, terms.op, terms.threshold) || (terms.latch && stored);
    if (now && !stored) breached.push(terms.id);
    return now;
  });

  // 3. Fee dues.
  const feeDue = config.fees.map((line) =>
    line.amount.kind === 'fixed' ? line.amount.amount : accrue(notesOpen, line.amount.rate, days),
  );

  // 4. Available amount.
  const full = enforced || config.reserve.release === 'full';
  const released = full ? state.reserve : maximum(state.reserve - required, 0n);
  let reserve = state.reserve - released;
  let available = input.collections + released + state.carry;
  const availableAtTop = available;
  let carry = 0n;
  let drawn = 0n;
  let residual = 0n;
  let feesOut = 0n;
  let owed = state.owed;
  // The asset balance of the deal follows each transfer.
  let balance = state.balance + input.collections;

  // 5. Ranks.
  const lines: EngineLine[] = [];
  for (const entry of enforced ? config.enforced : config.normal) {
    if (!holds(config, entry.when, triggers)) continue;
    const dues = entry.items.map((item): bigint => {
      switch (item.kind) {
        case 'fee':
          return feeDue[item.index] ?? 0n;
        case 'interest':
          return interestDue[item.class] ?? 0n;
        case 'principal':
          return (perNote[item.class] ?? 0n) * (notes[item.class] ?? 0n);
        case 'reserveRefill':
          return maximum(required - reserve, 0n);
        case 'residual':
          return available;
      }
    });
    const total = dues.reduce((sum, due) => sum + due, 0n);
    // An on-need reserve covers the shortfall of a draw rank.
    if (!full && total > available && reserve > 0n && config.reserve.drawRanks.includes(entry.id)) {
      const draw = minimum(total - available, reserve);
      reserve -= draw;
      available += draw;
      drawn += draw;
    }
    const shares = allocate(entry.alloc, dues, available);
    entry.items.forEach((item, position) => {
      const due = dues[position] as bigint;
      const share = shares[position] as bigint;
      let paid = share;
      switch (item.kind) {
        case 'fee': {
          if (share > 0n) {
            feesOut += share;
            const recipient = config.fees[item.index]?.recipient ?? '';
            if (parked.has(recipient)) owed += share;
            else balance -= share;
          }
          break;
        }
        case 'interest': {
          const rounded = roundPerNote(share, notes[item.class] as bigint, unit);
          paid = rounded.paid;
          shortfall[item.class] = due - share;
          (payments[item.class] as ClassPayment).interest = paid;
          carry += rounded.dust;
          break;
        }
        case 'principal': {
          if (share > 0n) {
            const count = notes[item.class] as bigint;
            const rounded = roundPerNote(share, count, unit);
            paid = rounded.paid;
            perNote[item.class] = (perNote[item.class] as bigint) - paid / count;
            const payment = payments[item.class] as ClassPayment;
            payment.principal = paid;
            payment.perNotePrincipal = paid / count;
            carry += rounded.dust;
          }
          break;
        }
        case 'reserveRefill':
          reserve += share;
          break;
        case 'residual':
          residual += share;
          break;
      }
      available -= share;
      if (due > 0n) lines.push({ rank: entry.id, item, due, paid, dust: share - paid });
    });
  }
  // 6. Cash left after the last rank goes to the carry.
  carry += available;

  // The paying agent takes the cash of the noteholders.
  const agentTotal = payments.reduce((sum, payment) => sum + payment.interest + payment.principal, 0n);
  balance -= agentTotal;

  // The residual to the Seller, and the maturity sweep.
  const matured = perNote.every((value) => value === 0n);
  const sellerParked = parked.has(config.seller);
  let residualOut = residual;
  let surplus = 0n;
  let toSeller = residual;
  if (matured) {
    const ledgers = residual + reserve + carry;
    const sweep = maximum(ledgers, balance - owed);
    residualOut = ledgers;
    surplus = sweep - ledgers;
    toSeller = sweep;
    reserve = 0n;
    carry = 0n;
  }
  if (toSeller > 0n) {
    if (sellerParked) owed += toSeller;
    else balance -= toSeller;
  }

  const paidOut = feesOut + agentTotal + residualOut;
  const settled: Settlement = {
    collections: input.collections,
    reserveIn: state.reserve,
    carryIn: state.carry,
    drawn,
    paidOut,
    reserve,
    carry,
    owed,
    balance,
    surplus,
  };
  if (settled.collections + settled.reserveIn + settled.carryIn !== paidOut + reserve + carry) {
    throw new Error('The copy of the engine does not conserve the cash. This is a defect of the copy.');
  }
  return {
    enforced,
    lines,
    settled,
    breached,
    payments,
    required,
    released,
    available: availableAtTop,
    residual: toSeller,
    matured,
    closing: {
      phase: matured ? 'Matured' : state.phase,
      reserve,
      carry,
      owed,
      balance,
      perNote,
      shortfall,
      triggers,
    },
  };
}

/**
 * The smallest collections that repay every class at this payment date.
 * More collections give more principal, so a search on `runPeriod` finds
 * the amount.
 */
export function payoffCollections(config: OnChainDealConfig, state: EngineState, fixing: bigint | null): bigint {
  const run = (collections: bigint): boolean => runPeriod(config, state, { collections, fixing }).matured;
  // An upper limit: twice the notes, the required reserve, and one year of fees.
  let high = 2n * notesOutstanding(config, state.perNote) + requiredReserve(config, false, initialNotes(config)) + 1n;
  for (const line of config.fees) {
    high += line.amount.kind === 'fixed' ? line.amount.amount : initialNotes(config);
  }
  if (!run(high)) throw new Error('No amount of collections repays the notes at this payment date.');
  let low = 0n;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (run(middle)) high = middle;
    else low = middle + 1n;
  }
  return high;
}
