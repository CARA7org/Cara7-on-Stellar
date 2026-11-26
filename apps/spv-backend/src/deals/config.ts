import { readFileSync } from 'node:fs';
import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { errorMessage } from '../custody/errors.js';
import { isWholeMultiple, percentToRateUnits, toBaseUnits } from './amounts.js';
import {
  DEAL_NETWORKS,
  SETTLEMENT_ASSETS,
  findSettlementAsset,
  settlementAsset,
  type SettlementAsset,
} from './assets.js';
import { MAX_CLASSES, RATE_SCALE, type OnChainDealConfig } from './onchain.js';
import {
  accountAddress,
  decimalAmount,
  percent,
  referenceWaterfall,
  resolveWaterfall,
  waterfallIssues,
  waterfallSchema,
  type ResolvedWaterfall,
} from './waterfall-config.js';

/**
 * Deal configuration file. One JSON file describes one deal: the network,
 * the settlement asset, the note classes, the priority of payments and the
 * initial whitelist. `pnpm deal:deploy --config <file>` reads it.
 *
 * - Version 2 has a `waterfall` block: the fee lines, the reserve rule, the
 *   triggers and the two orders of payments (see waterfall-config.ts). A
 *   floating rate can have a floor of the all-in rate (`floorPct`) and a
 *   floor of the index (`indexFloorPct`).
 * - Version 1 has `reserve`, `feesPerPeriod` and `feesRecipient` and no
 *   order: it is the reference order (fees, interest of each class, reserve,
 *   sequential principal, residual), with a floor of 0 % on a floating rate.
 *   The loader gives a version 1 file the form of version 2.
 * - Amounts are decimal strings in units of the settlement asset. The
 *   deploy tool reads the asset decimals on chain. Then it converts each
 *   amount to base units with string math.
 * - Rates are percent strings. "0.60" becomes 600 rate units of 0.001 %.
 * - A value such as "<FILL: ...>" is a placeholder. A file with a
 *   placeholder is a template: the loader refuses it and names each
 *   placeholder.
 */
export const DEAL_CONFIG_VERSIONS = [1, 2] as const;
export { MAX_CLASSES };
export const SENIORITY_LABELS = ['SENIOR', 'MEZZANINE', 'JUNIOR'] as const;
export type SeniorityLabel = (typeof SENIORITY_LABELS)[number];

const PLACEHOLDER = /^<[\s\S]*>$/;

const contractAddress = z
  .string()
  .refine((value) => StrKey.isValidContract(value), 'a contract address (C...) expected');

const fixedRate = z.object({ kind: z.literal('fixed'), ratePct: percent }).strict();
const rateSchemaV1 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('floating'), spreadPct: percent }).strict(),
  fixedRate,
]);
const rateSchemaV2 = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('floating'),
      spreadPct: percent,
      // The floor of the all-in rate, and the floor of the index before the spread.
      floorPct: percent.nullable().optional(),
      indexFloorPct: percent.nullable().optional(),
    })
    .strict(),
  fixedRate,
]);

const classFields = {
  letter: z.string().regex(/^[A-Z]$/, 'one capital letter expected'),
  label: z.enum(SENIORITY_LABELS),
  notes: z.number().int().positive(),
  // The name and the symbol of the note token. Defaults: see below.
  name: z.string().trim().min(1).max(100).optional(),
  symbol: z
    .string()
    .regex(/^[A-Za-z0-9]{1,12}$/, '1 to 12 letters or digits expected')
    .optional(),
};
const classSchemaV1 = z.object({ ...classFields, rate: rateSchemaV1 }).strict();
const classSchemaV2 = z.object({ ...classFields, rate: rateSchemaV2 }).strict();

/** True when a decimal string is more than 0. */
function isPositive(value: string): boolean {
  return /[1-9]/.test(value);
}

const commonFields = {
  network: z.enum(DEAL_NETWORKS),
  name: z.string().trim().min(1).max(200),
  series: z.string().regex(/^[A-Za-z0-9]{1,4}$/, '1 to 4 letters or digits expected'),
  asset: contractAddress,
  denominationCurrency: z.literal('EUR'),
  denomination: decimalAmount,
  roundUnit: decimalAmount,
  daysInPeriod: z.number().int().min(1).max(366),
  oracle: contractAddress,
  oracleMaxStalenessSecs: z.number().int().positive(),
  seller: accountAddress,
  eligible: z.array(accountAddress),
};

const versionOneSchema = z
  .object({
    ...commonFields,
    version: z.literal(1),
    reserve: decimalAmount,
    feesPerPeriod: decimalAmount,
    feesRecipient: accountAddress,
    classes: z.array(classSchemaV1).min(1).max(MAX_CLASSES),
  })
  .strict();

export const dealConfigSchema = z
  .object({
    ...commonFields,
    version: z.literal(2),
    classes: z.array(classSchemaV2).min(1).max(MAX_CLASSES),
    waterfall: waterfallSchema,
  })
  .strict();

/** A deal config in the form of version 2. A version 1 file takes this form at load. */
export type DealConfigFile = z.infer<typeof dealConfigSchema>;

export class DealConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DealConfigError';
  }
}

export interface Placeholder {
  path: string;
  value: string;
}

function formatPath(path: readonly PropertyKey[]): string {
  let text = '';
  for (const key of path) {
    text += typeof key === 'number' ? `[${key}]` : `${text.length > 0 ? '.' : ''}${String(key)}`;
  }
  return text.length > 0 ? text : '(file)';
}

/** Every string value of the form "<...>", with its path in the file. */
export function findPlaceholders(value: unknown, path: PropertyKey[] = []): Placeholder[] {
  if (typeof value === 'string') {
    return PLACEHOLDER.test(value) ? [{ path: formatPath(path), value }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findPlaceholders(item, [...path, index]));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => findPlaceholders(item, [...path, key]));
  }
  return [];
}

interface ConfigIssue {
  path: PropertyKey[];
  message: string;
}

/** The rules that the shape of the file does not give. */
function configIssues(config: DealConfigFile): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const issue = (path: PropertyKey[], message: string): void => {
    issues.push({ path, message });
  };
  const letters = new Map<string, number>();
  config.classes.forEach((terms, index) => {
    const first = letters.get(terms.letter);
    if (first !== undefined) {
      issue(['classes', index, 'letter'], `the letter ${terms.letter} is already used by classes[${first}]`);
    } else {
      letters.set(terms.letter, index);
    }
  });
  const holders = new Set<string>();
  config.eligible.forEach((holder, index) => {
    if (holders.has(holder)) issue(['eligible', index], `${holder} is in the list twice`);
    holders.add(holder);
  });
  if (!isPositive(config.denomination)) issue(['denomination'], 'more than 0 expected');
  if (!isPositive(config.roundUnit)) {
    issue(['roundUnit'], 'more than 0 expected');
  } else if (!isWholeMultiple(config.denomination, config.roundUnit)) {
    issue(['denomination'], `a whole multiple of roundUnit (${config.roundUnit}) expected`);
  }
  if (!findSettlementAsset(config.network, config.asset)) {
    const allowed = SETTLEMENT_ASSETS[config.network].map((entry) => entry.sac).join(', ');
    issue(['asset'], `not a settlement asset of ${config.network}. Use one of: ${allowed}`);
  }
  issues.push(...waterfallIssues(config.waterfall, [...letters.keys()]));
  return issues;
}

/** Gives a version 1 file the form of version 2: the reference order. */
function upgrade(config: z.infer<typeof versionOneSchema>): DealConfigFile {
  const { reserve, feesPerPeriod, feesRecipient, classes, ...common } = config;
  return {
    ...common,
    version: 2,
    classes: classes.map((terms) =>
      // The reference deal floors the all-in rate of a floating class at 0 %.
      terms.rate.kind === 'floating' ? { ...terms, rate: { ...terms.rate, floorPct: '0' } } : terms,
    ),
    waterfall: referenceWaterfall({
      letters: classes.map((terms) => terms.letter),
      reserve,
      feesPerPeriod,
      feesRecipient,
    }),
  };
}

/** Validates a parsed deal config. `source` names the file in the messages. */
export function parseDealConfig(raw: unknown, source = 'The deal config'): DealConfigFile {
  const placeholders = findPlaceholders(raw);
  if (placeholders.length > 0) {
    const lines = placeholders.map((entry) => `  ${entry.path}: ${entry.value}`);
    throw new DealConfigError(
      `${source} is a template. Replace each placeholder with a real value before a deploy:\n` +
        lines.join('\n'),
    );
  }
  const fail = (issues: readonly ConfigIssue[]): never => {
    const lines = issues.map((item) => `  ${formatPath(item.path)}: ${item.message}`);
    throw new DealConfigError(`${source} is not valid:\n${lines.join('\n')}`);
  };
  const version = typeof raw === 'object' && raw !== null && 'version' in raw ? raw.version : undefined;
  let config: DealConfigFile;
  if (version === 1) {
    const parsed = versionOneSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues);
    config = upgrade(parsed.data);
  } else if (version === 2) {
    const parsed = dealConfigSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues);
    config = parsed.data;
  } else {
    return fail([{ path: ['version'], message: `${DEAL_CONFIG_VERSIONS.join(' or ')} expected` }]);
  }
  const issues = configIssues(config);
  if (issues.length > 0) return fail(issues);
  return config;
}

/** Reads and validates a deal config file. */
export function loadDealConfig(file: string): DealConfigFile {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new DealConfigError(`The deal config ${file} is not readable: ${errorMessage(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DealConfigError(`The deal config ${file} is not valid JSON: ${errorMessage(error)}`);
  }
  return parseDealConfig(raw, `The deal config ${file}`);
}

/** One note class, ready for the contracts. */
export interface ClassPlan {
  index: number;
  letter: string;
  label: SeniorityLabel;
  /** The rate in units of 0.001 %: the spread (floating) or the rate (fixed). */
  rate: { kind: 'floating' | 'fixed'; units: bigint };
  /** The floor of the all-in rate and the floor of the index, in units of 0.001 %. */
  floor: bigint | null;
  indexFloor: bigint | null;
  notes: bigint;
  /** The name and the symbol of the note token. */
  name: string;
  symbol: string;
}

/** A deal config with its amounts in base units of the settlement asset. */
export interface DealTerms {
  config: DealConfigFile;
  asset: SettlementAsset;
  decimals: number;
  denomination: bigint;
  roundUnit: bigint;
  classes: ClassPlan[];
  /** The priority of payments in on-chain units. */
  waterfall: ResolvedWaterfall;
  /** The subordinated loan that the seller funds before the closing. */
  initialReserve: bigint;
}

export function defaultNoteName(series: string, letter: string): string {
  return `CARA7 Series ${series} Class ${letter} Notes`;
}

export function defaultNoteSymbol(series: string, letter: string): string {
  return `CARA7${letter}${series}`;
}

/**
 * Converts the amounts with the decimals of the asset (read on chain). An
 * amount with more decimals than the asset has gives an error.
 */
export function resolveDealTerms(config: DealConfigFile, decimals: number): DealTerms {
  const denomination = toBaseUnits(config.denomination, decimals, 'denomination');
  const roundUnit = toBaseUnits(config.roundUnit, decimals, 'roundUnit');
  const classes = config.classes.map((terms, index): ClassPlan => {
    const label = `classes[${index}].rate`;
    const floor = (value: string | null | undefined, name: string): bigint | null =>
      value === null || value === undefined ? null : percentToRateUnits(value, `${label}.${name}`);
    const plan = {
      index,
      letter: terms.letter,
      label: terms.label,
      notes: BigInt(terms.notes),
      name: terms.name ?? defaultNoteName(config.series, terms.letter),
      symbol: terms.symbol ?? defaultNoteSymbol(config.series, terms.letter),
    };
    if (terms.rate.kind === 'floating') {
      return {
        ...plan,
        rate: { kind: 'floating', units: percentToRateUnits(terms.rate.spreadPct, label) },
        floor: floor(terms.rate.floorPct, 'floorPct'),
        indexFloor: floor(terms.rate.indexFloorPct, 'indexFloorPct'),
      };
    }
    return {
      ...plan,
      rate: { kind: 'fixed', units: percentToRateUnits(terms.rate.ratePct, label) },
      floor: null,
      indexFloor: null,
    };
  });
  const waterfall = resolveWaterfall(
    config.waterfall,
    config.classes.map((terms) => terms.letter),
    decimals,
  );
  // The required reserve at the closing, on the initial notes.
  const face = classes.reduce((sum, plan) => sum + plan.notes * denomination, 0n);
  const rule = waterfall.reserve.required;
  let initialReserve = rule.kind === 'fixed' ? rule.amount : (face * rule.pct) / RATE_SCALE;
  if (rule.kind === 'pctOfNotes' && initialReserve < rule.floor) initialReserve = rule.floor;
  return {
    config,
    asset: settlementAsset(config.network, config.asset),
    decimals,
    denomination,
    roundUnit,
    classes,
    waterfall,
    initialReserve,
  };
}

/** The admin and the servicer of a deal: two operator wallets. */
export interface DealRoles {
  admin: string;
  servicer: string;
}

/** The configuration of the contract: the terms of the file and the two roles. */
export function dealOnChainConfig(terms: DealTerms, roles: DealRoles): OnChainDealConfig {
  const { config } = terms;
  return {
    admin: roles.admin,
    asset: config.asset,
    oracle: config.oracle,
    seller: config.seller,
    servicer: roles.servicer,
    daysInPeriod: config.daysInPeriod,
    oracleMaxStalenessSecs: BigInt(config.oracleMaxStalenessSecs),
    noteDenomination: terms.denomination,
    roundUnit: terms.roundUnit,
    classes: terms.classes.map((plan) => ({
      rate: plan.rate,
      totalNotes: plan.notes,
      floor: plan.floor,
      indexFloor: plan.indexFloor,
    })),
    ...terms.waterfall,
  };
}
