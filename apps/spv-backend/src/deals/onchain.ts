import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { z } from 'zod';

/**
 * The `DealConfig` of the abs-deal contract, and its codec.
 *
 * - `OnChainDealConfig` is the configuration in on-chain units: amounts in
 *   base units of the asset, rates in units of 0.001 %, factors in units of
 *   1 / 10,000,000.
 * - `encodeDealConfig` gives the constructor argument of the contract.
 * - `decodeDealConfig` reads the value that `get_config` returns. It also
 *   reads a deal of the earlier contract code, which has one fixed order of
 *   payments: the decoder gives it the reference order.
 *
 * The module is pure: no network, no key. A test checks the codec against
 * the configurations of the contract tests (contracts/abs-deal/vectors).
 */

/** 100 % in rate units of 0.001 %. */
export const RATE_SCALE = 100_000n;
/** 100 % in factor units. */
export const FACTOR_SCALE = 10_000_000n;

/** The limits of the contract (contracts/abs-deal/src/types.rs). */
export const MAX_CLASSES = 8;
export const MAX_FEES = 4;
export const MAX_TRIGGERS = 4;
export const MAX_RANKS = 24;
export const MAX_RANK_ITEMS = 8;
export const MAX_ORDER_ITEMS = 40;

export interface OnChainClass {
  rate: { kind: 'floating' | 'fixed'; units: bigint };
  totalNotes: bigint;
  /** Floor of the all-in rate of a floating class. */
  floor: bigint | null;
  /** Floor of the index of a floating class, before the spread. */
  indexFloor: bigint | null;
}

export type OnChainFeeAmount =
  | { kind: 'fixed'; amount: bigint }
  | { kind: 'perAnnum'; rate: bigint };

export interface OnChainFee {
  recipient: string;
  amount: OnChainFeeAmount;
}

export type OnChainRequired =
  | { kind: 'fixed'; amount: bigint }
  | { kind: 'pctOfNotes'; pct: bigint; floor: bigint };

export interface OnChainReserve {
  required: OnChainRequired;
  release: 'full' | 'onNeed';
  drawRanks: string[];
}

export type OnChainMetric =
  | { kind: 'classFactor'; class: number }
  | { kind: 'notesFactor' }
  | { kind: 'reserveShortfall' }
  | { kind: 'classShortfall'; class: number };

export const TRIGGER_OPS = ['gt', 'ge', 'lt', 'le'] as const;
export type TriggerOp = (typeof TRIGGER_OPS)[number];

export interface OnChainTrigger {
  id: string;
  metric: OnChainMetric;
  op: TriggerOp;
  threshold: bigint;
  latch: boolean;
}

export type OnChainCond =
  | { kind: 'always' }
  | { kind: 'trigger'; id: string }
  | { kind: 'notTrigger'; id: string };

export type OnChainItem =
  | { kind: 'fee'; index: number }
  | { kind: 'interest'; class: number }
  | { kind: 'principal'; class: number }
  | { kind: 'reserveRefill' }
  | { kind: 'residual' };

export type RankAlloc = 'sequential' | 'pariPassu';

export interface OnChainRank {
  id: string;
  when: OnChainCond;
  alloc: RankAlloc;
  items: OnChainItem[];
}

export interface OnChainDealConfig {
  admin: string;
  asset: string;
  oracle: string;
  seller: string;
  servicer: string;
  daysInPeriod: number;
  oracleMaxStalenessSecs: bigint;
  noteDenomination: bigint;
  roundUnit: bigint;
  classes: OnChainClass[];
  fees: OnChainFee[];
  reserve: OnChainReserve;
  triggers: OnChainTrigger[];
  normal: OnChainRank[];
  enforced: OnChainRank[];
}

/* ---- the reference order ---- */

const CLASS_LETTERS = 'abcdefgh';

/** The id of the rank of one class: `int_a`, `acc_b`. */
export function classRankId(prefix: 'int' | 'acc', classIndex: number): string {
  const letter = CLASS_LETTERS[classIndex];
  if (letter === undefined) throw new Error(`The class index ${classIndex} is not from 0 to 7.`);
  return `${prefix}_${letter}`;
}

function rank(id: string, items: OnChainItem[]): OnChainRank {
  return { id, when: { kind: 'always' }, alloc: 'sequential', items };
}

/**
 * The reference order of payments, for `classCount` classes and one fee line.
 *
 * - normal: fees, the interest of each class, the reserve re-fund,
 *   sequential principal, the residual;
 * - enforced: fees, then each class in turn (interest then principal), the
 *   residual.
 *
 * The contract tests build the same order (contracts/abs-deal/src/reference.rs).
 */
export function referenceOrders(classCount: number): { normal: OnChainRank[]; enforced: OnChainRank[] } {
  const classes = Array.from({ length: classCount }, (_value, index) => index);
  return {
    normal: [
      rank('fees', [{ kind: 'fee', index: 0 }]),
      ...classes.map((index) => rank(classRankId('int', index), [{ kind: 'interest', class: index }])),
      rank('reserve', [{ kind: 'reserveRefill' }]),
      rank('principal', classes.map((index): OnChainItem => ({ kind: 'principal', class: index }))),
      rank('residual', [{ kind: 'residual' }]),
    ],
    enforced: [
      rank('fees', [{ kind: 'fee', index: 0 }]),
      ...classes.map((index) =>
        rank(classRankId('acc', index), [
          { kind: 'interest', class: index },
          { kind: 'principal', class: index },
        ]),
      ),
      rank('residual', [{ kind: 'residual' }]),
    ],
  };
}

/* ---- encoder ---- */

const symbol = (name: string): xdr.ScVal => xdr.ScVal.scvSymbol(name);
const i128 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: 'i128' });
const u32 = (value: number): xdr.ScVal => xdr.ScVal.scvU32(value);
const address = (value: string): xdr.ScVal => new Address(value).toScVal();
const list = (values: xdr.ScVal[]): xdr.ScVal => xdr.ScVal.scvVec(values);
/** `Option<i128>`: void for none. */
const optional = (value: bigint | null): xdr.ScVal => (value === null ? xdr.ScVal.scvVoid() : i128(value));
/** An enum variant: a list that starts with the variant name. */
const variant = (name: string, ...values: xdr.ScVal[]): xdr.ScVal => list([symbol(name), ...values]);

/** A contracttype struct: a map with symbol keys in sorted order. */
export function structVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const keys = Object.keys(fields).sort();
  return xdr.ScVal.scvMap(
    keys.map((key) => new xdr.ScMapEntry({ key: symbol(key), val: fields[key] as xdr.ScVal })),
  );
}

const OP_NAMES: Record<TriggerOp, string> = { gt: 'Gt', ge: 'Ge', lt: 'Lt', le: 'Le' };

function metricVal(metric: OnChainMetric): xdr.ScVal {
  switch (metric.kind) {
    case 'classFactor':
      return variant('ClassFactor', u32(metric.class));
    case 'notesFactor':
      return variant('NotesFactor');
    case 'reserveShortfall':
      return variant('ReserveShortfall');
    case 'classShortfall':
      return variant('ClassShortfall', u32(metric.class));
  }
}

function condVal(when: OnChainCond): xdr.ScVal {
  switch (when.kind) {
    case 'always':
      return variant('Always');
    case 'trigger':
      return variant('Trigger', symbol(when.id));
    case 'notTrigger':
      return variant('NotTrigger', symbol(when.id));
  }
}

function itemVal(item: OnChainItem): xdr.ScVal {
  switch (item.kind) {
    case 'fee':
      return variant('Fee', u32(item.index));
    case 'interest':
      return variant('Interest', u32(item.class));
    case 'principal':
      return variant('Principal', u32(item.class));
    case 'reserveRefill':
      return variant('ReserveRefill');
    case 'residual':
      return variant('Residual');
  }
}

function rankVal(entry: OnChainRank): xdr.ScVal {
  return structVal({
    alloc: variant(entry.alloc === 'sequential' ? 'Sequential' : 'PariPassu'),
    id: symbol(entry.id),
    items: list(entry.items.map(itemVal)),
    when: condVal(entry.when),
  });
}

/** The constructor argument of the abs-deal contract. */
export function encodeDealConfig(config: OnChainDealConfig): xdr.ScVal {
  const classes = config.classes.map((terms) =>
    structVal({
      floor: optional(terms.floor),
      index_floor: optional(terms.indexFloor),
      rate: variant(terms.rate.kind === 'floating' ? 'Floating' : 'Fixed', i128(terms.rate.units)),
      total_notes: i128(terms.totalNotes),
    }),
  );
  const fees = config.fees.map((line) =>
    structVal({
      amount:
        line.amount.kind === 'fixed'
          ? variant('Fixed', i128(line.amount.amount))
          : variant('PerAnnum', i128(line.amount.rate)),
      recipient: address(line.recipient),
    }),
  );
  const required = config.reserve.required;
  const reserve = structVal({
    draw_ranks: list(config.reserve.drawRanks.map(symbol)),
    release: variant(config.reserve.release === 'full' ? 'Full' : 'OnNeed'),
    required:
      required.kind === 'fixed'
        ? variant('Fixed', i128(required.amount))
        : variant('PctOfNotes', i128(required.pct), i128(required.floor)),
  });
  const triggers = config.triggers.map((terms) =>
    structVal({
      id: symbol(terms.id),
      latch: xdr.ScVal.scvBool(terms.latch),
      metric: metricVal(terms.metric),
      op: variant(OP_NAMES[terms.op]),
      threshold: i128(terms.threshold),
    }),
  );
  return structVal({
    admin: address(config.admin),
    asset: address(config.asset),
    classes: list(classes),
    days_in_period: u32(config.daysInPeriod),
    enforced: list(config.enforced.map(rankVal)),
    fees: list(fees),
    normal: list(config.normal.map(rankVal)),
    note_denomination: i128(config.noteDenomination),
    oracle: address(config.oracle),
    oracle_max_staleness_secs: nativeToScVal(config.oracleMaxStalenessSecs, { type: 'u64' }),
    reserve,
    round_unit: i128(config.roundUnit),
    seller: address(config.seller),
    servicer: address(config.servicer),
    triggers: list(triggers),
  });
}

/* ---- decoder ---- */

// `scValToNative` gives a bigint for i128 and u64, a number for u32, a
// string for a symbol or an address, null for void, and a list that starts
// with the variant name for an enum.
const amount = z.union([z.bigint(), z.number().int()]).transform((value) => BigInt(value));
const optionalAmount = amount.nullish().transform((value) => value ?? null);
const index = z.number().int().nonnegative();

const rateSchema = z
  .tuple([z.enum(['Floating', 'Fixed']), amount])
  .transform(([name, units]) => ({ kind: name === 'Floating' ? ('floating' as const) : ('fixed' as const), units }));

const feeAmountSchema = z.union([
  z.tuple([z.literal('Fixed'), amount]).transform(([, value]): OnChainFeeAmount => ({ kind: 'fixed', amount: value })),
  z.tuple([z.literal('PerAnnum'), amount]).transform(([, value]): OnChainFeeAmount => ({ kind: 'perAnnum', rate: value })),
]);

const requiredSchema = z.union([
  z.tuple([z.literal('Fixed'), amount]).transform(([, value]): OnChainRequired => ({ kind: 'fixed', amount: value })),
  z
    .tuple([z.literal('PctOfNotes'), amount, amount])
    .transform(([, pct, floor]): OnChainRequired => ({ kind: 'pctOfNotes', pct, floor })),
]);

const metricSchema = z.union([
  z.tuple([z.literal('ClassFactor'), index]).transform(([, value]): OnChainMetric => ({ kind: 'classFactor', class: value })),
  z.tuple([z.literal('NotesFactor')]).transform((): OnChainMetric => ({ kind: 'notesFactor' })),
  z.tuple([z.literal('ReserveShortfall')]).transform((): OnChainMetric => ({ kind: 'reserveShortfall' })),
  z
    .tuple([z.literal('ClassShortfall'), index])
    .transform(([, value]): OnChainMetric => ({ kind: 'classShortfall', class: value })),
]);

const opSchema = z
  .tuple([z.enum(['Gt', 'Ge', 'Lt', 'Le'])])
  .transform(([name]) => name.toLowerCase() as TriggerOp);

const condSchema = z.union([
  z.tuple([z.literal('Always')]).transform((): OnChainCond => ({ kind: 'always' })),
  z.tuple([z.literal('Trigger'), z.string()]).transform(([, id]): OnChainCond => ({ kind: 'trigger', id })),
  z.tuple([z.literal('NotTrigger'), z.string()]).transform(([, id]): OnChainCond => ({ kind: 'notTrigger', id })),
]);

/** One item of a rank, as `get_config` and the `rank_lines` event give it. */
export const itemSchema = z.union([
  z.tuple([z.literal('Fee'), index]).transform(([, value]): OnChainItem => ({ kind: 'fee', index: value })),
  z.tuple([z.literal('Interest'), index]).transform(([, value]): OnChainItem => ({ kind: 'interest', class: value })),
  z.tuple([z.literal('Principal'), index]).transform(([, value]): OnChainItem => ({ kind: 'principal', class: value })),
  z.tuple([z.literal('ReserveRefill')]).transform((): OnChainItem => ({ kind: 'reserveRefill' })),
  z.tuple([z.literal('Residual')]).transform((): OnChainItem => ({ kind: 'residual' })),
]);

const rankSchema = z
  .object({
    id: z.string(),
    when: condSchema,
    alloc: z.tuple([z.enum(['Sequential', 'PariPassu'])]),
    items: z.array(itemSchema),
  })
  .transform(
    (entry): OnChainRank => ({
      id: entry.id,
      when: entry.when,
      alloc: entry.alloc[0] === 'Sequential' ? 'sequential' : 'pariPassu',
      items: entry.items,
    }),
  );

const commonFields = {
  admin: z.string(),
  asset: z.string(),
  oracle: z.string(),
  seller: z.string(),
  servicer: z.string(),
  days_in_period: z.number().int(),
  oracle_max_staleness_secs: amount,
  note_denomination: amount,
  round_unit: amount,
};

/** The configuration of the rank engine. */
const currentSchema = z.object({
  ...commonFields,
  classes: z.array(
    z.object({ rate: rateSchema, total_notes: amount, floor: optionalAmount, index_floor: optionalAmount }),
  ),
  fees: z.array(z.object({ recipient: z.string(), amount: feeAmountSchema })),
  reserve: z.object({
    required: requiredSchema,
    release: z.tuple([z.enum(['Full', 'OnNeed'])]),
    draw_ranks: z.array(z.string()),
  }),
  triggers: z.array(
    z.object({ id: z.string(), metric: metricSchema, op: opSchema, threshold: amount, latch: z.boolean() }),
  ),
  normal: z.array(rankSchema),
  enforced: z.array(rankSchema),
});

/** The configuration of the earlier contract code: one fixed order. */
const earlierSchema = z.object({
  ...commonFields,
  classes: z.array(z.object({ rate: rateSchema, total_notes: amount })),
  fees_recipient: z.string(),
  fees_per_period: amount,
  required_reserve: amount,
});

function common(native: z.infer<typeof currentSchema> | z.infer<typeof earlierSchema>) {
  return {
    admin: native.admin,
    asset: native.asset,
    oracle: native.oracle,
    seller: native.seller,
    servicer: native.servicer,
    daysInPeriod: native.days_in_period,
    oracleMaxStalenessSecs: native.oracle_max_staleness_secs,
    noteDenomination: native.note_denomination,
    roundUnit: native.round_unit,
  };
}

/** True when `native` is the configuration of a deal of the earlier code. */
export function isEarlierDealConfig(native: unknown): boolean {
  return typeof native === 'object' && native !== null && 'fees_per_period' in native;
}

/**
 * Reads the value of `get_config` (after `scValToNative`). A deal of the
 * earlier code gets the reference order: that code pays in this order.
 */
export function decodeDealConfig(native: unknown): OnChainDealConfig {
  if (isEarlierDealConfig(native)) {
    const earlier = earlierSchema.parse(native);
    return {
      ...common(earlier),
      classes: earlier.classes.map((terms) => ({
        rate: terms.rate,
        totalNotes: terms.total_notes,
        // The earlier code floors the all-in rate of a floating class at 0.
        floor: terms.rate.kind === 'floating' ? 0n : null,
        indexFloor: null,
      })),
      fees: [{ recipient: earlier.fees_recipient, amount: { kind: 'fixed', amount: earlier.fees_per_period } }],
      reserve: { required: { kind: 'fixed', amount: earlier.required_reserve }, release: 'full', drawRanks: [] },
      triggers: [],
      ...referenceOrders(earlier.classes.length),
    };
  }
  const current = currentSchema.parse(native);
  return {
    ...common(current),
    classes: current.classes.map((terms) => ({
      rate: terms.rate,
      totalNotes: terms.total_notes,
      floor: terms.floor,
      indexFloor: terms.index_floor,
    })),
    fees: current.fees,
    reserve: {
      required: current.reserve.required,
      release: current.reserve.release[0] === 'Full' ? 'full' : 'onNeed',
      drawRanks: current.reserve.draw_ranks,
    },
    triggers: current.triggers,
    normal: current.normal,
    enforced: current.enforced,
  };
}

/** The initial balance of the notes: the sum of notes x denomination. */
export function initialNotes(config: OnChainDealConfig): bigint {
  return config.classes.reduce((sum, terms) => sum + terms.totalNotes * config.noteDenomination, 0n);
}

/** True when a class of the deal floats: the deal then reads the oracle. */
export function hasFloatingClass(config: OnChainDealConfig): boolean {
  return config.classes.some((terms) => terms.rate.kind === 'floating');
}
