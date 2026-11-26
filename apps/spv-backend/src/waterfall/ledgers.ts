import type { StellarNetwork } from '../custody/ports.js';
import { formatUnits } from '../deals/amounts.js';
import { hasFloatingClass, type OnChainDealConfig, type OnChainItem } from '../deals/onchain.js';
import {
  notesOutstanding,
  payoffCollections,
  requiredReserve,
  runPeriod,
  type DealPhase,
  type EngineLine,
  type EngineState,
  type PeriodResult,
  type Settlement,
} from './engine.js';
import { addressArg } from './soroban.js';

/**
 * The ledgers of a deal, read on chain for the copy of the engine, and the
 * JSON form of a payment date that the copy computed.
 */
type ContractReader = StellarNetwork['read'];

const ENGINE_PHASES: readonly string[] = ['Amortizing', 'Enforced', 'Matured'];

/** A getter that only the later contract codes have: the default for an earlier deal. */
async function readOr<T>(load: () => Promise<unknown>, fallback: T): Promise<T> {
  try {
    return ((await load()) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Reads the ledgers of a deal after its closing. Null before the closing
 * and for an aborted deal: the engine has nothing to run.
 */
export async function readEngineState(
  read: ContractReader,
  dealId: string,
  config: OnChainDealConfig,
): Promise<EngineState | null> {
  // `scValToNative` gives a list with the variant name for the state.
  const phase = String(await read(dealId, 'get_state'));
  if (!ENGINE_PHASES.includes(phase)) return null;
  const [reserve, carry, classStates, balance, owed, triggers] = await Promise.all([
    read(dealId, 'get_reserve') as Promise<bigint>,
    read(dealId, 'get_carry') as Promise<bigint>,
    read(dealId, 'get_class_states') as Promise<{ per_note_outstanding: bigint; shortfall: bigint }[]>,
    read(config.asset, 'balance', [addressArg(dealId)]) as Promise<bigint>,
    readOr<bigint>(() => read(dealId, 'get_owed_total'), 0n),
    readOr<boolean[]>(() => read(dealId, 'get_triggers'), []),
  ]);
  return {
    phase: phase as DealPhase,
    reserve: BigInt(reserve),
    carry: BigInt(carry),
    owed: BigInt(owed),
    balance: BigInt(balance),
    perNote: classStates.map((state) => BigInt(state.per_note_outstanding)),
    shortfall: classStates.map((state) => BigInt(state.shortfall)),
    triggers: config.triggers.map((_terms, index) => triggers[index] === true),
  };
}

/** The fixing of the oracle of the deal. Null for a deal with fixed rates only. */
export async function readFixing(read: ContractReader, config: OnChainDealConfig): Promise<bigint | null> {
  if (!hasFloatingClass(config)) return null;
  const fixing = (await read(config.oracle, 'lastprice')) as { price: bigint } | null;
  if (!fixing) throw new Error(`The oracle ${config.oracle} has no fixing.`);
  return BigInt(fixing.price);
}

/* ---- the JSON form ---- */

export interface LineView {
  rank: string;
  /** fee, interest, principal, reserveRefill or residual. */
  item: OnChainItem['kind'];
  /** The class of an interest or a principal line, from 0. */
  class: number | null;
  /** The fee line of a fee item, from 0. */
  feeIndex: number | null;
  due: string;
  paid: string;
  dust: string;
}

export type SettlementView = Record<keyof Settlement, string>;

export interface PeriodView {
  enforced: boolean;
  lines: LineView[];
  settled: SettlementView;
  breached: string[];
  matures: boolean;
  /** The cash of the Seller, with the maturity sweep. */
  residual: string;
  /** The ledgers after the payment date. */
  closing: { reserve: string; carry: string; perNote: string[]; shortfall: string[] };
}

export function lineView(line: EngineLine, units: (value: bigint) => string): LineView {
  const { item } = line;
  return {
    rank: line.rank,
    item: item.kind,
    class: item.kind === 'interest' || item.kind === 'principal' ? item.class : null,
    feeIndex: item.kind === 'fee' ? item.index : null,
    due: units(line.due),
    paid: units(line.paid),
    dust: units(line.dust),
  };
}

export function settlementView(settled: Settlement, units: (value: bigint) => string): SettlementView {
  return {
    collections: units(settled.collections),
    reserveIn: units(settled.reserveIn),
    carryIn: units(settled.carryIn),
    drawn: units(settled.drawn),
    paidOut: units(settled.paidOut),
    reserve: units(settled.reserve),
    carry: units(settled.carry),
    owed: units(settled.owed),
    balance: units(settled.balance),
    surplus: units(settled.surplus),
  };
}

/** A payment date of the copy, with exact decimal strings in units of the asset. */
export function periodView(result: PeriodResult, decimals: number): PeriodView {
  const units = (value: bigint): string => formatUnits(value, decimals);
  return {
    enforced: result.enforced,
    lines: result.lines.map((line) => lineView(line, units)),
    settled: settlementView(result.settled, units),
    breached: result.breached,
    matures: result.matured,
    residual: units(result.residual),
    closing: {
      reserve: units(result.closing.reserve),
      carry: units(result.closing.carry),
      perNote: result.closing.perNote.map(units),
      shortfall: result.closing.shortfall.map(units),
    },
  };
}

export interface EngineView {
  phase: DealPhase;
  /** The required reserve of the next payment date. */
  requiredReserve: string;
  triggers: { id: string; set: boolean }[];
  /** The smallest collections that repay every class at the next payment date. */
  payoffCollections: string | null;
  /** The next payment date with the collections of the request. */
  preview: PeriodView | null;
}

/**
 * What the next payment date gives, computed by the copy of the engine from
 * the ledgers on chain. `collections` is in base units of the asset.
 */
export function engineView(
  config: OnChainDealConfig,
  state: EngineState,
  fixing: bigint | null,
  decimals: number,
  collections: bigint | null,
): EngineView {
  const units = (value: bigint): string => formatUnits(value, decimals);
  const open = state.phase !== 'Matured';
  return {
    phase: state.phase,
    requiredReserve: units(
      requiredReserve(config, state.phase === 'Enforced', notesOutstanding(config, state.perNote)),
    ),
    triggers: config.triggers.map((terms, index) => ({ id: terms.id, set: state.triggers[index] === true })),
    payoffCollections: open ? units(payoffCollections(config, state, fixing)) : null,
    preview: open && collections !== null ? periodView(runPeriod(config, state, { collections, fixing }), decimals) : null,
  };
}
