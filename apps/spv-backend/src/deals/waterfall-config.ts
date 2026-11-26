import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { percentToRateUnits, toBaseUnits } from './amounts.js';
import {
  MAX_FEES,
  MAX_ORDER_ITEMS,
  MAX_RANKS,
  MAX_RANK_ITEMS,
  MAX_TRIGGERS,
  TRIGGER_OPS,
  referenceOrders,
  type OnChainCond,
  type OnChainFee,
  type OnChainItem,
  type OnChainRank,
  type OnChainReserve,
  type OnChainTrigger,
} from './onchain.js';

/**
 * The `waterfall` block of a deal config file, version 2: the priority of
 * payments of the deal. A new prospectus is a new block, not a new contract.
 *
 * - `fees`: 1 to 4 fee lines. A fixed amount for each period, or a rate per
 *   year on the opening balance of the notes.
 * - `reserve`: the required amount (fixed, or a percent of the notes with a
 *   floor), and how the reserve enters the cash of a period. `full`: the
 *   whole reserve is released, then re-funded at its rank. `onNeed`: the
 *   reserve covers only the shortfall of the ranks in `drawRanks`.
 * - `triggers`: a metric of the opening ledgers, compared with a threshold.
 *   The threshold of a factor is a percent ("50"). The threshold of a
 *   shortfall is an amount of the asset.
 * - `normal` and `enforced`: the two orders. A rank has an id, a condition
 *   on a trigger, a split rule and its items. An item names a class by its
 *   letter and a fee line by its position in `fees`.
 *
 * The rules of this file mirror the `validate` function of the contract
 * (contracts/abs-deal/src/validate.rs). The contract is the authority: it
 * refuses a configuration that these rules let through.
 */

export const decimalAmount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'a decimal string such as "10" or "0.01" expected');
export const percent = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'a percent with at most 3 decimals expected, for example "0.60"');
export const accountAddress = z
  .string()
  .refine((value) => StrKey.isValidEd25519PublicKey(value), 'an account address (G...) expected');

/** The digits of a factor threshold: 100 % is 10,000,000 factor units. */
const FACTOR_PERCENT_DECIMALS = 5;

const rankId = z.string().regex(/^[A-Za-z0-9_]{1,16}$/, 'an id of 1 to 16 letters, digits or "_" expected');
const classLetter = z.string().regex(/^[A-Z]$/, 'the letter of a class expected');

const condSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('always') }).strict(),
  z.object({ kind: z.literal('trigger'), id: rankId }).strict(),
  z.object({ kind: z.literal('notTrigger'), id: rankId }).strict(),
]);

const itemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fee'), index: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('interest'), class: classLetter }).strict(),
  z.object({ kind: z.literal('principal'), class: classLetter }).strict(),
  z.object({ kind: z.literal('reserveRefill') }).strict(),
  z.object({ kind: z.literal('residual') }).strict(),
]);

const rankSchema = z
  .object({
    id: rankId,
    // No condition: the rank always runs.
    when: condSchema.optional(),
    alloc: z.enum(['sequential', 'pariPassu']),
    items: z.array(itemSchema).min(1).max(MAX_RANK_ITEMS),
  })
  .strict();

const feeSchema = z
  .object({
    recipient: accountAddress,
    amount: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('fixed'), amount: decimalAmount }).strict(),
      z.object({ kind: z.literal('perAnnum'), ratePct: percent }).strict(),
    ]),
  })
  .strict();

const metricSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('classFactor'), class: classLetter }).strict(),
  z.object({ kind: z.literal('notesFactor') }).strict(),
  z.object({ kind: z.literal('reserveShortfall') }).strict(),
  z.object({ kind: z.literal('classShortfall'), class: classLetter }).strict(),
]);

const triggerSchema = z
  .object({
    id: rankId,
    metric: metricSchema,
    op: z.enum(TRIGGER_OPS),
    threshold: decimalAmount,
    latch: z.boolean(),
  })
  .strict();

export const waterfallSchema = z
  .object({
    fees: z.array(feeSchema).max(MAX_FEES),
    reserve: z
      .object({
        required: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('fixed'), amount: decimalAmount }).strict(),
          z.object({ kind: z.literal('pctOfNotes'), pct: percent, floor: decimalAmount }).strict(),
        ]),
        release: z.enum(['full', 'onNeed']),
        drawRanks: z.array(rankId),
      })
      .strict(),
    triggers: z.array(triggerSchema).max(MAX_TRIGGERS),
    normal: z.array(rankSchema).min(1).max(MAX_RANKS),
    enforced: z.array(rankSchema).min(1).max(MAX_RANKS),
  })
  .strict();

export type WaterfallFile = z.infer<typeof waterfallSchema>;
type RankFile = WaterfallFile['normal'][number];
type ItemFile = RankFile['items'][number];
type CondFile = NonNullable<RankFile['when']>;

/**
 * The reference waterfall in the form of the file: one fixed fee line, a
 * fixed reserve released in full, no trigger, and the reference order. A
 * version 1 file has these terms.
 */
export function referenceWaterfall(input: {
  letters: readonly string[];
  reserve: string;
  feesPerPeriod: string;
  feesRecipient: string;
}): WaterfallFile {
  const toFile = (order: OnChainRank[]): RankFile[] =>
    order.map((entry) => ({
      id: entry.id,
      alloc: entry.alloc,
      items: entry.items.map((item): ItemFile => {
        if (item.kind === 'interest' || item.kind === 'principal') {
          return { kind: item.kind, class: input.letters[item.class] as string };
        }
        return item;
      }),
    }));
  const orders = referenceOrders(input.letters.length);
  return {
    fees: [{ recipient: input.feesRecipient, amount: { kind: 'fixed', amount: input.feesPerPeriod } }],
    reserve: { required: { kind: 'fixed', amount: input.reserve }, release: 'full', drawRanks: [] },
    triggers: [],
    normal: toFile(orders.normal),
    enforced: toFile(orders.enforced),
  };
}

/* ---- the rules of a structure ---- */

export interface WaterfallIssue {
  path: PropertyKey[];
  message: string;
}

type ItemKind = ItemFile['kind'];

/** The key of the thing that an item pays: one fee line, one class leg. */
function itemKey(item: ItemFile): string {
  switch (item.kind) {
    case 'fee':
      return `fee ${item.index}`;
    case 'interest':
      return `interest of Class ${item.class}`;
    case 'principal':
      return `principal of Class ${item.class}`;
    case 'reserveRefill':
      return 'reserve re-fund';
    case 'residual':
      return 'residual';
  }
}

interface Seen {
  count: number;
  when: CondFile;
  /** True when the two ranks have opposite conditions on one trigger. */
  paired: boolean;
  /** Rank position x 100 + item position, of the first and the last place. */
  first: number;
  last: number;
}

function opposite(left: CondFile, right: CondFile): boolean {
  return (
    left.kind !== 'always' &&
    right.kind !== 'always' &&
    left.kind !== right.kind &&
    left.id === right.id
  );
}

function hasReserve(file: WaterfallFile): boolean {
  const rule = file.reserve.required;
  const positive = (value: string): boolean => /[1-9]/.test(value);
  return rule.kind === 'fixed' ? positive(rule.amount) : positive(rule.pct) || positive(rule.floor);
}

function orderIssues(
  file: WaterfallFile,
  name: 'normal' | 'enforced',
  letters: readonly string[],
): WaterfallIssue[] {
  const issues: WaterfallIssue[] = [];
  const order = file[name];
  const triggerIds = new Set(file.triggers.map((terms) => terms.id));
  const seen = new Map<string, Seen>();
  const ids = new Set<string>();
  let itemsTotal = 0;

  order.forEach((entry, position) => {
    const at = (...rest: PropertyKey[]): PropertyKey[] => ['waterfall', name, position, ...rest];
    if (ids.has(entry.id)) issues.push({ path: at('id'), message: `the id "${entry.id}" is used twice in the ${name} order` });
    ids.add(entry.id);
    const when: CondFile = entry.when ?? { kind: 'always' };
    if (when.kind !== 'always' && !triggerIds.has(when.id)) {
      issues.push({ path: at('when'), message: `the trigger "${when.id}" is not in waterfall.triggers` });
    }
    itemsTotal += entry.items.length;
    const kinds = new Set<ItemKind>(entry.items.map((item) => item.kind));
    if (entry.alloc === 'pariPassu' && (kinds.size > 1 || kinds.has('reserveRefill') || kinds.has('residual'))) {
      issues.push({
        path: at('alloc'),
        message: 'a pari passu rank holds items of one kind: fee lines, or interest, or principal',
      });
    }
    entry.items.forEach((item, itemPosition) => {
      if ((item.kind === 'interest' || item.kind === 'principal') && !letters.includes(item.class)) {
        issues.push({ path: at('items', itemPosition, 'class'), message: `the deal has no Class ${item.class}` });
        return;
      }
      if (item.kind === 'fee' && item.index >= file.fees.length) {
        issues.push({
          path: at('items', itemPosition, 'index'),
          message: `the deal has ${file.fees.length} fee line(s): no fee line ${item.index}`,
        });
        return;
      }
      if (item.kind === 'residual' && (entry.items.length !== 1 || position !== order.length - 1 || when.kind !== 'always')) {
        issues.push({
          path: at('items', itemPosition),
          message: 'the residual is alone in the last rank, and this rank has no condition',
        });
      }
      const key = itemKey(item);
      const place = position * 100 + itemPosition;
      const earlier = seen.get(key);
      if (!earlier) {
        seen.set(key, { count: 1, when, paired: false, first: place, last: place });
      } else if (earlier.count === 1 && opposite(earlier.when, when)) {
        earlier.count = 2;
        earlier.paired = true;
        earlier.last = place;
      } else {
        earlier.count += 1;
        issues.push({
          path: at('items', itemPosition),
          message:
            `the ${key} is in more than one rank that can run. Use one rank with no condition, ` +
            'or two ranks with the conditions "trigger" and "notTrigger" on one trigger',
        });
      }
    });
  });

  if (itemsTotal > MAX_ORDER_ITEMS) {
    issues.push({ path: ['waterfall', name], message: `at most ${MAX_ORDER_ITEMS} items in an order, not ${itemsTotal}` });
  }
  const runsOnce = (entry: Seen | undefined): boolean =>
    entry !== undefined && ((entry.count === 1 && entry.when.kind === 'always') || entry.paired);
  const need = (key: string): void => {
    const entry = seen.get(key);
    if (runsOnce(entry)) return;
    const reason = entry ? 'runs only under a condition' : 'has no rank';
    issues.push({ path: ['waterfall', name], message: `the ${key} ${reason} in the ${name} order` });
  };
  file.fees.forEach((_line, index) => need(`fee ${index}`));
  for (const letter of letters) {
    need(`interest of Class ${letter}`);
    need(`principal of Class ${letter}`);
    const interest = seen.get(`interest of Class ${letter}`);
    const principal = seen.get(`principal of Class ${letter}`);
    if (interest && principal && interest.last >= principal.first) {
      issues.push({
        path: ['waterfall', name],
        message: `the interest of Class ${letter} ranks before its principal in the ${name} order`,
      });
    }
  }
  need('residual');
  const refill = seen.get('reserve re-fund');
  if (refill && !runsOnce(refill)) need('reserve re-fund');
  if (name === 'normal' && hasReserve(file) && !refill) {
    issues.push({ path: ['waterfall', 'normal'], message: 'a deal with a reserve needs a "reserveRefill" rank in the normal order' });
  }
  return issues;
}

/** Every rule that a waterfall block breaks, with its path in the file. */
export function waterfallIssues(file: WaterfallFile, letters: readonly string[]): WaterfallIssue[] {
  const issues: WaterfallIssue[] = [];
  const triggerIds = new Set<string>();
  file.triggers.forEach((terms, position) => {
    if (triggerIds.has(terms.id)) {
      issues.push({ path: ['waterfall', 'triggers', position, 'id'], message: `the id "${terms.id}" is used twice` });
    }
    triggerIds.add(terms.id);
    const metric = terms.metric;
    if ((metric.kind === 'classFactor' || metric.kind === 'classShortfall') && !letters.includes(metric.class)) {
      issues.push({ path: ['waterfall', 'triggers', position, 'metric', 'class'], message: `the deal has no Class ${metric.class}` });
    }
  });
  issues.push(...orderIssues(file, 'normal', letters), ...orderIssues(file, 'enforced', letters));

  const { release, drawRanks } = file.reserve;
  if (release === 'full' && drawRanks.length > 0) {
    issues.push({ path: ['waterfall', 'reserve', 'drawRanks'], message: 'a reserve released in full has no draw rank' });
  }
  drawRanks.forEach((id, position) => {
    const entry = file.normal.find((candidate) => candidate.id === id);
    const path: PropertyKey[] = ['waterfall', 'reserve', 'drawRanks', position];
    if (!entry) {
      issues.push({ path, message: `"${id}" is not a rank of the normal order` });
    } else if (entry.items.some((item) => item.kind !== 'fee' && item.kind !== 'interest')) {
      issues.push({ path, message: `the rank "${id}" holds an item that is not a fee or interest: the reserve covers fees and interest only` });
    }
  });
  return issues;
}

/* ---- from the file to on-chain units ---- */

export interface ResolvedWaterfall {
  fees: OnChainFee[];
  reserve: OnChainReserve;
  triggers: OnChainTrigger[];
  normal: OnChainRank[];
  enforced: OnChainRank[];
}

/**
 * Converts the block to on-chain units: amounts with the decimals of the
 * asset, rates to units of 0.001 %, class letters to class positions.
 */
export function resolveWaterfall(
  file: WaterfallFile,
  letters: readonly string[],
  decimals: number,
): ResolvedWaterfall {
  const classIndex = (letter: string): number => letters.indexOf(letter);
  const resolveCond = (when: CondFile | undefined): OnChainCond => when ?? { kind: 'always' };
  const resolveItem = (item: ItemFile): OnChainItem =>
    item.kind === 'interest' || item.kind === 'principal'
      ? { kind: item.kind, class: classIndex(item.class) }
      : item;
  const resolveOrder = (order: RankFile[]): OnChainRank[] =>
    order.map((entry) => ({
      id: entry.id,
      when: resolveCond(entry.when),
      alloc: entry.alloc,
      items: entry.items.map(resolveItem),
    }));
  const required = file.reserve.required;
  return {
    fees: file.fees.map((line, position) => ({
      recipient: line.recipient,
      amount:
        line.amount.kind === 'fixed'
          ? { kind: 'fixed', amount: toBaseUnits(line.amount.amount, decimals, `waterfall.fees[${position}].amount`) }
          : { kind: 'perAnnum', rate: percentToRateUnits(line.amount.ratePct, `waterfall.fees[${position}].ratePct`) },
    })),
    reserve: {
      required:
        required.kind === 'fixed'
          ? { kind: 'fixed', amount: toBaseUnits(required.amount, decimals, 'waterfall.reserve.required.amount') }
          : {
              kind: 'pctOfNotes',
              pct: percentToRateUnits(required.pct, 'waterfall.reserve.required.pct'),
              floor: toBaseUnits(required.floor, decimals, 'waterfall.reserve.required.floor'),
            },
      release: file.reserve.release,
      drawRanks: [...file.reserve.drawRanks],
    },
    triggers: file.triggers.map((terms, position) => {
      const label = `waterfall.triggers[${position}].threshold`;
      const metric = terms.metric;
      if (metric.kind === 'classFactor' || metric.kind === 'notesFactor') {
        return {
          id: terms.id,
          metric: metric.kind === 'classFactor' ? { kind: 'classFactor', class: classIndex(metric.class) } : metric,
          op: terms.op,
          // A percent: "50" is half of the initial balance.
          threshold: toBaseUnits(terms.threshold, FACTOR_PERCENT_DECIMALS, label),
          latch: terms.latch,
        };
      }
      return {
        id: terms.id,
        metric: metric.kind === 'classShortfall' ? { kind: 'classShortfall', class: classIndex(metric.class) } : metric,
        op: terms.op,
        // An amount of the asset.
        threshold: toBaseUnits(terms.threshold, decimals, label),
        latch: terms.latch,
      };
    }),
    normal: resolveOrder(file.normal),
    enforced: resolveOrder(file.enforced),
  };
}
