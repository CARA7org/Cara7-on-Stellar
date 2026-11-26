import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Address, Operation, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { environment } from '../config.js';
import { formatUnits, rateUnitsToBps } from '../deals/amounts.js';
import { NETWORK_PASSPHRASE, readAssetInfo, settlementAsset, type AssetInfo } from '../deals/assets.js';
import {
  dealOnChainConfig,
  loadDealConfig,
  resolveDealTerms,
  type ClassPlan,
  type DealConfigFile,
  type DealRoles,
  type DealTerms,
  type SeniorityLabel,
} from '../deals/config.js';
import { encodeDealConfig, hasFloatingClass, type OnChainItem, type OnChainRank } from '../deals/onchain.js';
import { addressArg, i128Arg, server } from '../waterfall/soroban.js';
import { isMainModule, runCli, scriptArguments } from './cli.js';
import { eligibleRequests } from './eligible.js';
import { errorMessage } from './errors.js';
import type { Operator, OperatorRequest } from './operator.js';
import type { StellarNetwork } from './ports.js';
import { defaultOperatorServices } from './services.js';
import { runAndWait } from './wait.js';
import { wiringRequest } from './wire-deal.js';

/**
 * pnpm deal:deploy --config deals/<file>.json
 *                  (--wasm-dir ../../target/wasm32v1-none/release | --from-deal C...)
 *                  [--register http://localhost:8080] [--save <file>.json]
 *
 * Deploys a deal from a deal config file (src/deals/config.ts). The admin
 * and the servicer of the deal are the operator wallets.
 *
 * 1. The script reads the config and the settlement asset on chain. It
 *    refuses an asset that is not in the list of the network. It also
 *    refuses a role conflict: the admin, the servicer and the reporter of
 *    the oracle are three addresses.
 * 2. Contract code. With --wasm-dir, the crank uploads abs_deal.wasm,
 *    note_token.wasm and paying_agent.wasm. It skips a code that is already
 *    on chain. With --from-deal, the script reuses the code of a deal that
 *    runs the new contract code. The old deals (reference deal, Series 2)
 *    run the old code: they are not a source.
 * 3. The crank deploys the deal, one note token per class and the paying
 *    agent. The crank has no approval policy.
 * 4. The admin wires the deal (`set_wiring`) and sets the initial whitelist
 *    (`set_eligible`). A person approves each admin signature in Dfns.
 * 5. With --register, the script adds the deal and its classes to the
 *    tranching-api registry, so that the front shows it.
 * 6. With --save, the script writes the ids, the code hashes and the hash
 *    of each transaction to a JSON file: the record of the deploy.
 */
const USAGE =
  'Usage: pnpm deal:deploy --config deals/<file>.json ' +
  '(--wasm-dir ../../target/wasm32v1-none/release | --from-deal C...) ' +
  '[--register http://localhost:8080] [--save <file>.json]';

export interface DeployOptions {
  configPath: string;
  wasmDir: string | null;
  fromDeal: string | null;
  registerUrl: string | null;
  /** The file of the deploy record, or null. */
  savePath?: string | null;
}

export function parseDeployArgs(argv: string[]): DeployOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      'wasm-dir': { type: 'string' },
      'from-deal': { type: 'string' },
      register: { type: 'string' },
      save: { type: 'string' },
    },
    strict: true,
  });
  if (!values.config) throw new Error(`--config is missing. ${USAGE}`);
  const wasmDir = values['wasm-dir'] ?? null;
  const fromDeal = values['from-deal'] ?? null;
  if ((wasmDir === null) === (fromDeal === null)) {
    throw new Error(`Give --wasm-dir or --from-deal (one of them). ${USAGE}`);
  }
  if (fromDeal !== null && !StrKey.isValidContract(fromDeal)) {
    throw new Error(`--from-deal ${fromDeal} is not a contract address (C...).`);
  }
  const register = values.register ?? null;
  if (register !== null && !/^https?:\/\/\S+$/.test(register)) {
    throw new Error(`--register ${register} is not an http or https URL.`);
  }
  return {
    configPath: values.config,
    wasmDir,
    fromDeal,
    registerUrl: register === null ? null : register.replace(/\/+$/, ''),
    savePath: values.save ?? null,
  };
}

/** A config for another network than the backend gives an error. */
export function checkNetwork(config: DealConfigFile, networkPassphrase: string): void {
  if (NETWORK_PASSPHRASE[config.network] !== networkPassphrase) {
    throw new Error(
      `The deal config is for ${config.network}, but this backend uses the network ` +
        `"${networkPassphrase}". Set NETWORK_PASSPHRASE and SOROBAN_RPC_URL for ${config.network} first.`,
    );
  }
}

/**
 * Reads the settlement asset on chain. The asset contract must say that it
 * is the listed asset: a SAC has the name "CODE:ISSUER".
 */
export async function readSettlementAsset(
  read: StellarNetwork['read'],
  config: DealConfigFile,
): Promise<AssetInfo> {
  const listed = settlementAsset(config.network, config.asset);
  const info = await readAssetInfo(read, config.asset);
  const expected = `${listed.code}:${listed.issuer}`;
  if (info.name !== expected) {
    throw new Error(
      `The asset contract ${config.asset} has the name "${info.name}", but the list of ` +
        `settlement assets says ${expected}. Check src/deals/assets.ts.`,
    );
  }
  return info;
}

export type { DealRoles };

/**
 * The constructor argument of the deal (`DealConfig`): the terms of the
 * config in base units, and the operator wallets as admin and servicer.
 */
export function dealConfigArg(terms: DealTerms, roles: DealRoles): xdr.ScVal {
  return encodeDealConfig(dealOnChainConfig(terms, roles));
}

export function noteTokenArgs(deal: string, plan: ClassPlan, denomination: bigint): xdr.ScVal[] {
  return [
    addressArg(deal),
    nativeToScVal(plan.name, { type: 'string' }),
    nativeToScVal(plan.symbol, { type: 'string' }),
    i128Arg(denomination),
  ];
}

export function payingAgentArgs(deal: string, asset: string, notes: string[]): xdr.ScVal[] {
  return [addressArg(deal), addressArg(asset), xdr.ScVal.scvVec(notes.map(addressArg))];
}

/** A contract deploy from code that is already on the network, signed by the crank. */
export function deployRequest(kind: string, deployer: string, wasmHash: Buffer, constructorArgs: xdr.ScVal[]): OperatorRequest {
  return {
    kind,
    role: 'crank',
    call: {
      type: 'host-function',
      method: 'deploy',
      operation: Operation.createCustomContract({
        address: new Address(deployer),
        wasmHash,
        salt: randomBytes(32),
        constructorArgs,
      }),
    },
  };
}

/* ---- contract code ---- */

export const WASM_FILES = {
  deal: 'abs_deal.wasm',
  note: 'note_token.wasm',
  agent: 'paying_agent.wasm',
} as const;
export type CodeName = keyof typeof WASM_FILES;
export type CodeHashes = Record<CodeName, Buffer>;
const CODE_NAMES = Object.keys(WASM_FILES) as CodeName[];
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/** The code hash of a wasm: its SHA-256. */
export function wasmHash(wasm: Buffer): Buffer {
  return createHash('sha256').update(wasm).digest();
}

/** A wasm upload, signed by the crank. The operation result is the code hash in hex. */
export function uploadRequest(kind: string, wasm: Buffer): OperatorRequest {
  return {
    kind,
    role: 'crank',
    call: {
      type: 'host-function',
      method: 'upload',
      operation: Operation.uploadContractWasm({ wasm }),
    },
    finish: async (outcome) =>
      outcome.result instanceof Uint8Array ? Buffer.from(outcome.result).toString('hex') : null,
  };
}

/** What the deploy needs from the network, the custody and the registry. Tests give fakes. */
export interface DeployContext {
  operator: Operator;
  read: StellarNetwork['read'];
  networkPassphrase: string;
  /** True when a live code entry with this hash is on chain. */
  codeExists(hash: Buffer): Promise<boolean>;
  /** The code hash of a deployed contract. */
  codeHashOf(contractId: string): Promise<Buffer>;
  /** Posts a JSON body to the tranching-api. Only with --register. */
  post?: (pathname: string, body: unknown) => Promise<unknown>;
  log(line: string): void;
  /** Receives each transaction of the deploy: what it did and its hash. */
  record?: (kind: string, hash: string) => void;
}

async function readWasm(dir: string, name: CodeName): Promise<Buffer> {
  const file = path.resolve(dir, WASM_FILES[name]);
  let wasm: Buffer;
  try {
    wasm = await readFile(file);
  } catch (error) {
    throw new Error(`The wasm file ${file} is not readable: ${errorMessage(error)}`);
  }
  if (!wasm.subarray(0, 4).equals(WASM_MAGIC)) throw new Error(`The file ${file} is not a wasm module.`);
  return wasm;
}

/** Uploads the three wasm files of `dir`. A code that is already on chain is not uploaded again. */
export async function codeFromWasmDir(context: DeployContext, dir: string): Promise<CodeHashes> {
  const files = await Promise.all(CODE_NAMES.map((name) => readWasm(dir, name)));
  const hashes: Partial<CodeHashes> = {};
  for (const [index, name] of CODE_NAMES.entries()) {
    const wasm = files[index] as Buffer;
    const hash = wasmHash(wasm);
    const hex = hash.toString('hex');
    if (await context.codeExists(hash)) {
      context.log(`${WASM_FILES[name]}: the code ${hex} is on chain, no upload`);
    } else {
      const done = await runAndWait(context.operator, uploadRequest(`upload-${name}`, wasm));
      if (done.result !== hex) {
        throw new Error(`The upload of ${WASM_FILES[name]} (tx ${done.hash}) gave the code ${String(done.result)}, not ${hex}.`);
      }
      context.log(`${WASM_FILES[name]}: uploaded the code ${hex} (tx ${done.hash})`);
      context.record?.(`upload-${name}`, done.hash);
    }
    hashes[name] = hash;
  }
  return hashes as CodeHashes;
}

/** The code of a deal that runs the rank engine, and of its note token and paying agent. */
export async function codeFromDeal(context: DeployContext, deal: string): Promise<CodeHashes> {
  try {
    // Only the code of the rank engine has this function. The earlier
    // codes (reference deal, Series 2, Series 4) have one fixed order.
    await context.read(deal, 'get_required_reserve');
  } catch (error) {
    throw new Error(
      `--from-deal ${deal} does not run the abs-deal code of the rank engine: get_required_reserve fails ` +
        `(${errorMessage(error)}). Give a deal of this code, or use --wasm-dir.`,
    );
  }
  const wiring = (await context.read(deal, 'get_wiring')) as {
    note_tokens: string[];
    paying_agent: string;
  } | null;
  const note = wiring?.note_tokens[0];
  if (!wiring || !note) {
    throw new Error(`--from-deal ${deal} is not wired, so its note and paying agent code is not known. Use --wasm-dir.`);
  }
  try {
    await context.read(note, 'controller');
  } catch (error) {
    throw new Error(
      `The note token ${note} of --from-deal does not run the new note-token code: controller() ` +
        `fails (${errorMessage(error)}). Use --wasm-dir.`,
    );
  }
  const [dealCode, noteCode, agentCode] = await Promise.all([
    context.codeHashOf(deal),
    context.codeHashOf(note),
    context.codeHashOf(wiring.paying_agent),
  ]);
  return { deal: dealCode, note: noteCode, agent: agentCode };
}

/* ---- tranching-api registry ---- */

// The limits of the tranching-api registry (apps/tranching-api/src/registry.ts).
const REGISTRY_MAX_PERIOD_DAYS = 90;
const REGISTRY_MAX_COUPON_BPS = 10_000;
const REGISTRY_MAX_SYMBOL = 12;

export interface TrancheBody {
  classIndex: number;
  name: string;
  seniority: SeniorityLabel;
  rateKind: 'FLOATING' | 'FIXED';
  /** FIXED: the rate in basis points. FLOATING: the spread in basis points. */
  couponBps: number;
  contractId: string;
  baseAssetId: string;
  assetSymbol: string;
  assetDecimals: number;
  /** Notes x denomination, in base units of the asset. */
  originalFace: string;
}

export function couponBps(plan: ClassPlan): number {
  const bps = rateUnitsToBps(plan.rate.units);
  if (bps > REGISTRY_MAX_COUPON_BPS) {
    throw new Error(`Class ${plan.letter}: the registry accepts at most ${REGISTRY_MAX_COUPON_BPS} basis points.`);
  }
  return bps;
}

/** Stops before the first transaction when the registry cannot take the deal. */
export function checkRegistrable(terms: DealTerms, asset: AssetInfo): void {
  if (terms.config.daysInPeriod > REGISTRY_MAX_PERIOD_DAYS) {
    throw new Error(`The registry accepts at most ${REGISTRY_MAX_PERIOD_DAYS} days in a period.`);
  }
  if (asset.symbol.length === 0 || asset.symbol.length > REGISTRY_MAX_SYMBOL) {
    throw new Error(`The registry accepts an asset symbol of 1 to ${REGISTRY_MAX_SYMBOL} characters, not "${asset.symbol}".`);
  }
  for (const plan of terms.classes) couponBps(plan);
}

export interface Deployed {
  deal: string;
  notes: string[];
  payingAgent: string;
}

export function dealBody(terms: DealTerms, asset: AssetInfo, deployed: Deployed): Record<string, unknown> {
  const { config } = terms;
  return {
    name: config.name,
    description:
      `Series ${config.series}: ${terms.classes.length} note classes, settled in ${asset.symbol}. ` +
      'Deployed with pnpm deal:deploy.',
    dealContractId: deployed.deal,
    payingAgentContractId: deployed.payingAgent,
    periodDays: config.daysInPeriod,
  };
}

export function trancheBodies(terms: DealTerms, asset: AssetInfo, notes: string[]): TrancheBody[] {
  return terms.classes.map((plan) => ({
    classIndex: plan.index,
    name: `Class ${plan.letter} Notes`,
    seniority: plan.label,
    rateKind: plan.rate.kind === 'floating' ? 'FLOATING' : 'FIXED',
    couponBps: couponBps(plan),
    contractId: notes[plan.index] ?? '',
    baseAssetId: terms.config.asset,
    assetSymbol: asset.symbol,
    assetDecimals: asset.decimals,
    originalFace: (plan.notes * terms.denomination).toString(),
  }));
}

/** Adds the deal, then each class. Returns the deal id of the registry. */
async function register(
  post: NonNullable<DeployContext['post']>,
  terms: DealTerms,
  asset: AssetInfo,
  deployed: Deployed,
): Promise<number> {
  const created = (await post('/api/deals', dealBody(terms, asset, deployed))) as { deal?: { id?: unknown } };
  const dealId = created.deal?.id;
  if (typeof dealId !== 'number') throw new Error('The registry returned no deal id.');
  for (const body of trancheBodies(terms, asset, deployed.notes)) {
    try {
      await post(`/api/deals/${dealId}/tranches`, body);
    } catch (error) {
      throw new Error(`The registry has the deal ${dealId}, but class ${body.classIndex} failed: ${errorMessage(error)}`);
    }
  }
  return dealId;
}

export function registryPoster(baseUrl: string): NonNullable<DeployContext['post']> {
  return async (pathname, body) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`POST ${pathname} answered ${response.status}: ${await response.text()}`);
    return response.json();
  };
}

/* ---- the deploy ---- */

export interface DeployResult extends Deployed {
  terms: DealTerms;
  asset: AssetInfo;
  /** The address of each role of the deal. */
  roles: { crank: string; admin: string; servicer: string; reporter: string | null };
  /** The code hash of each contract, in hex. */
  code: Record<CodeName, string>;
  /** Each transaction of the deploy, in order. */
  transactions: { kind: string; hash: string }[];
  /** The deal id in the registry, with --register. */
  registryDealId: number | null;
  /** The registry error. The deal is on chain all the same. */
  registryError: string | null;
}

async function deploy(context: DeployContext, request: OperatorRequest): Promise<string> {
  const done = await runAndWait(context.operator, request);
  const contractId = typeof done.result === 'string' ? done.result : '';
  if (!StrKey.isValidContract(contractId)) {
    throw new Error(`${request.kind}: the deploy ${done.hash} returned no contract address.`);
  }
  context.log(`${request.kind} ${contractId} (tx ${done.hash})`);
  context.record?.(request.kind, done.hash);
  return contractId;
}

function termLines(terms: DealTerms, asset: AssetInfo): string[] {
  const units = (value: bigint): string => `${formatUnits(value, terms.decimals)} ${asset.symbol}`;
  const percentOf = (rateUnits: bigint): string => `${formatUnits(rateUnits, 3)} %`;
  const { config, waterfall } = terms;
  const letter = (classIndex: number): string => terms.classes[classIndex]?.letter ?? '?';
  const itemText = (item: OnChainItem): string => {
    switch (item.kind) {
      case 'fee':
        return `fee ${item.index}`;
      case 'interest':
        return `interest ${letter(item.class)}`;
      case 'principal':
        return `principal ${letter(item.class)}`;
      case 'reserveRefill':
        return 'reserve re-fund';
      case 'residual':
        return 'residual';
    }
  };
  const rankText = (entry: OnChainRank, position: number): string => {
    const when = entry.when.kind === 'always' ? '' : ` [${entry.when.kind === 'trigger' ? 'when' : 'when not'} ${entry.when.id}]`;
    const split = entry.items.length > 1 ? ` (${entry.alloc === 'pariPassu' ? 'pari passu' : 'sequential'})` : '';
    return `  ${position + 1}. ${entry.id}${when}: ${entry.items.map(itemText).join(', ')}${split}`;
  };
  const required = waterfall.reserve.required;
  return [
    `deal "${config.name}" on ${config.network}, asset ${asset.symbol} ${config.asset} (${terms.asset.label}), ${asset.decimals} decimals`,
    ...terms.classes.map((plan) => {
      const floors = [
        plan.floor === null ? '' : `, floor ${percentOf(plan.floor)}`,
        plan.indexFloor === null ? '' : `, index floor ${percentOf(plan.indexFloor)}`,
      ].join('');
      const rate = `${plan.rate.kind} ${plan.rate.kind === 'floating' ? 'spread ' : ''}${percentOf(plan.rate.units)}${floors}`;
      return `class ${plan.letter} ${plan.label} ${rate}: ${plan.notes} notes of ${units(terms.denomination)}, token ${plan.symbol}`;
    }),
    ...waterfall.fees.map((line, index) => {
      const amount = line.amount.kind === 'fixed' ? `${units(line.amount.amount)} per period` : `${percentOf(line.amount.rate)} per year on the notes`;
      return `fee ${index}: ${amount}, to ${line.recipient}`;
    }),
    `reserve: ${required.kind === 'fixed' ? units(required.amount) : `${percentOf(required.pct)} of the notes, floor ${units(required.floor)}`}, ` +
      (waterfall.reserve.release === 'full'
        ? 'released in full each period'
        : `drawn on need by: ${waterfall.reserve.drawRanks.join(', ') || 'no rank'}`),
    `the seller funds ${units(terms.initialReserve)} of subordinated loan before the closing`,
    ...waterfall.triggers.map(
      (trigger) => `trigger ${trigger.id}: ${trigger.metric.kind} ${trigger.op} ${trigger.threshold}${trigger.latch ? ', latched' : ''}`,
    ),
    'normal order:',
    ...waterfall.normal.map(rankText),
    'enforced order:',
    ...waterfall.enforced.map(rankText),
    `${config.daysInPeriod} days per period, round unit ${units(terms.roundUnit)}`,
    `oracle ${config.oracle}, seller ${config.seller}`,
    `initial whitelist: ${config.eligible.length} holder(s)`,
  ];
}

/**
 * The three separate roles of a deal: the admin settles the issuance, the
 * servicer triggers a payment date, the reporter of the oracle publishes
 * the reference rate. The contract refuses one address in two roles. The
 * script checks this before the first transaction, with a readable error.
 * Returns the reporter, or null for a deal with fixed rates only.
 */
export async function checkRoles(
  context: Pick<DeployContext, 'read'>,
  terms: DealTerms,
  roles: DealRoles,
): Promise<string | null> {
  if (roles.admin === roles.servicer) {
    throw new Error(
      `The admin wallet and the servicer wallet have the same address (${roles.admin}). ` +
        'The contract refuses this deal: the two roles are separate.',
    );
  }
  if (!hasFloatingClass(dealOnChainConfig(terms, roles))) return null;
  const oracle = terms.config.oracle;
  let reporter: string;
  try {
    reporter = String(await context.read(oracle, 'get_reporter'));
  } catch (error) {
    throw new Error(
      `The oracle ${oracle} does not name its reporter: get_reporter fails (${errorMessage(error)}). ` +
        'A deal with a floating class needs an oracle that names its reporter.',
    );
  }
  for (const [role, address] of Object.entries(roles)) {
    if (reporter === address) {
      throw new Error(
        `The reporter of the oracle ${oracle} is the ${role} wallet (${address}). ` +
          'The contract refuses the closing and each payment date of this deal: the three roles are separate.',
      );
    }
  }
  return reporter;
}

/** The contracts on chain so far. An error message names them. */
interface Progress {
  deal: string | null;
  notes: string[];
  payingAgent: string | null;
}

function onChainSoFar(progress: Progress): string {
  if (!progress.deal) return 'No contract of the deal is on chain.';
  const lines = [`On chain so far: deal ${progress.deal}`];
  if (progress.notes.length > 0) lines.push(`note tokens ${progress.notes.join(',')}`);
  if (progress.payingAgent) lines.push(`paying agent ${progress.payingAgent}`);
  lines.push('Continue with pnpm deal:wire and pnpm deal:eligible, or deploy a new deal.');
  return lines.join('\n');
}

/**
 * The crank deploys the deal, the note tokens and the paying agent. Then the
 * admin wires the deal and sets the initial whitelist.
 */
async function deployContracts(
  context: DeployContext,
  terms: DealTerms,
  code: CodeHashes,
  crank: string,
  roles: DealRoles,
  progress: Progress,
): Promise<Deployed> {
  const { config } = terms;
  const deal = await deploy(context, deployRequest('deploy-deal', crank, code.deal, [dealConfigArg(terms, roles)]));
  progress.deal = deal;
  for (const plan of terms.classes) {
    const args = noteTokenArgs(deal, plan, terms.denomination);
    progress.notes.push(await deploy(context, deployRequest(`deploy-note-${plan.letter}`, crank, code.note, args)));
  }
  const notes = [...progress.notes];
  const agentArgs = payingAgentArgs(deal, config.asset, notes);
  const payingAgent = await deploy(context, deployRequest('deploy-paying-agent', crank, code.agent, agentArgs));
  progress.payingAgent = payingAgent;
  const wired = await runAndWait(context.operator, wiringRequest({ deal, notes, payingAgent }));
  context.log(`wired by the admin (tx ${wired.hash})`);
  context.record?.('set-wiring', wired.hash);
  for (const request of eligibleRequests({ deal, holders: config.eligible, eligible: true })) {
    const listed = await runAndWait(context.operator, request);
    context.log(`whitelist set by the admin (tx ${listed.hash})`);
    context.record?.('set-eligible', listed.hash);
  }
  return { deal, notes, payingAgent };
}

/** The full deploy. Each step logs its result. */
export async function deployDeal(options: DeployOptions, given: DeployContext): Promise<DeployResult> {
  const transactions: { kind: string; hash: string }[] = [];
  const context: DeployContext = {
    ...given,
    record: (kind, hash) => {
      transactions.push({ kind, hash });
      given.record?.(kind, hash);
    },
  };
  const config = loadDealConfig(path.resolve(options.configPath));
  checkNetwork(config, context.networkPassphrase);
  const asset = await readSettlementAsset(context.read, config);
  const terms = resolveDealTerms(config, asset.decimals);
  if (options.registerUrl !== null) {
    if (!context.post) throw new Error('--register needs a registry client.');
    checkRegistrable(terms, asset);
  }
  const [crank, admin, servicer] = await Promise.all(
    (['crank', 'admin', 'servicer'] as const).map((role) => context.operator.resolve(role)),
  );
  if (!crank || !admin || !servicer) throw new Error('A role wallet is missing.');
  const roles = { admin: admin.address, servicer: servicer.address };
  const reporter = await checkRoles(context, terms, roles);
  for (const line of termLines(terms, asset)) context.log(line);
  context.log(`crank ${crank.address} deploys; admin ${admin.address}, servicer ${servicer.address}`);
  if (reporter !== null) context.log(`reporter of the oracle: ${reporter}`);

  const code = options.wasmDir !== null
    ? await codeFromWasmDir(context, options.wasmDir)
    : await codeFromDeal(context, options.fromDeal ?? '');

  const progress: Progress = { deal: null, notes: [], payingAgent: null };
  let deployed: Deployed;
  try {
    deployed = await deployContracts(context, terms, code, crank.address, roles, progress);
  } catch (error) {
    throw new Error(`${errorMessage(error)}\n${onChainSoFar(progress)}`);
  }

  let registryDealId: number | null = null;
  let registryError: string | null = null;
  if (options.registerUrl !== null && context.post) {
    try {
      registryDealId = await register(context.post, terms, asset, deployed);
      context.log(`registered as deal ${registryDealId} in ${options.registerUrl}`);
    } catch (error) {
      registryError = errorMessage(error);
    }
  }
  return {
    ...deployed,
    terms,
    asset,
    roles: { crank: crank.address, admin: admin.address, servicer: servicer.address, reporter },
    code: { deal: code.deal.toString('hex'), note: code.note.toString('hex'), agent: code.agent.toString('hex') },
    transactions,
    registryDealId,
    registryError,
  };
}

/** The record of a deploy, for the --save file: public data only. */
export function deployRecord(result: DeployResult, options: DeployOptions): Record<string, unknown> {
  const { terms } = result;
  return {
    configFile: path.basename(options.configPath),
    name: terms.config.name,
    network: terms.config.network,
    deal: result.deal,
    notes: result.notes,
    payingAgent: result.payingAgent,
    oracle: terms.config.oracle,
    asset: terms.config.asset,
    roles: result.roles,
    code: result.code,
    initialReserve: terms.initialReserve.toString(),
    registryDealId: result.registryDealId,
    transactions: result.transactions,
  };
}

/* ---- network reads of the CLI ---- */

/** True when a live code entry with this hash is on chain. An archived entry needs a new upload. */
async function codeIsLive(hash: Buffer): Promise<boolean> {
  const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash }));
  const response = await server.getLedgerEntries(key);
  const entry = response.entries[0];
  if (!entry) return false;
  return entry.liveUntilLedgerSeq === undefined || entry.liveUntilLedgerSeq >= response.latestLedger;
}

/** The wasm hash of a deployed contract, read from its instance entry. */
export async function wasmHashOf(contractId: string): Promise<Buffer> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const response = await server.getLedgerEntries(key);
  const entry = response.entries[0];
  if (!entry) throw new Error(`The network has no instance for ${contractId}.`);
  return entry.val.contractData().val().instance().executable().wasmHash();
}

function printResult(result: DeployResult, options: DeployOptions): void {
  const { terms, deal, notes, payingAgent } = result;
  const { config } = terms;
  console.log('\nNew deal:');
  console.log(`  deal           ${deal}`);
  for (const plan of terms.classes) console.log(`  note ${plan.letter}         ${notes[plan.index] ?? ''}`);
  console.log(`  paying agent   ${payingAgent}`);
  console.log('\nContract code (wasm hash):');
  console.log(`  abs-deal       ${result.code.deal}`);
  console.log(`  note-token     ${result.code.note}`);
  console.log(`  paying-agent   ${result.code.agent}`);
  console.log(
    `\nBefore the closing, the seller funds ${formatUnits(terms.initialReserve, terms.decimals)} ${result.asset.symbol} ` +
      `of subordinated loan: fund_sub_loan --amount ${terms.initialReserve}`,
  );
  console.log('\nFor a spv-backend on this deal (.env), with the network settings of this backend:');
  console.log(`  DEAL_CONTRACT_ID=${deal}`);
  console.log(`  PAYING_AGENT_CONTRACT_ID=${payingAgent}`);
  console.log(`  RATE_ORACLE_CONTRACT_ID=${config.oracle}`);
  console.log('  PORT=8092');
  console.log(`\nFor the "deals" list of the custody-api policy (apps/custody-api/src/policy/${config.network}.json):`);
  console.log(
    JSON.stringify({
      name: config.name,
      dealContractId: deal,
      payingAgentContractId: payingAgent,
      noteDenomination: terms.denomination.toString(),
    }),
  );
  if (result.registryError !== null) {
    console.log(`\nThe deal is on chain, but the registration in ${options.registerUrl} failed: ${result.registryError}`);
  }
}

async function main(): Promise<void> {
  const options = parseDeployArgs(scriptArguments());
  const { operator, network } = defaultOperatorServices();
  const result = await deployDeal(options, {
    operator,
    read: network.read,
    networkPassphrase: environment.NETWORK_PASSPHRASE,
    codeExists: codeIsLive,
    codeHashOf: wasmHashOf,
    ...(options.registerUrl !== null ? { post: registryPoster(options.registerUrl) } : {}),
    log: (line) => console.log(`[deal:deploy] ${line}`),
  });
  printResult(result, options);
  if (options.savePath) {
    const file = path.resolve(options.savePath);
    await writeFile(file, `${JSON.stringify(deployRecord(result, options), null, 2)}\n`);
    console.log(`\nThe record of the deploy is in ${file}`);
  }
  if (result.registryError !== null) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) runCli(main);
