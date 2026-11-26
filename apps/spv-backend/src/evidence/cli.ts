import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Networks, StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { environment } from '../config.js';
import { isMainModule, runCli, scriptArguments } from '../custody/cli.js';
import { wasmHashOf } from '../custody/deploy-deal.js';
import { readContract, server } from '../waterfall/soroban.js';
import { allPassed, runChecks } from './checks.js';
import { collectEvidence, type CollectOptions } from './collect.js';
import { fromBundle, toBundle, type Evidence } from './model.js';
import { renderReport } from './report.js';

/**
 * pnpm deal:evidence [--deal C...] [--label "Deal S"] [--compare-code C...,C...]
 *                    [--deploy-log <file of deal:deploy --save>] [--from-ledger N]
 *                    [--account G...,G...] [--fixing 1=2209,2=2209]
 *                    [--bundle <events.json>] [--from-bundle <events.json>] [--out <evidence.md>]
 *
 * Reads the evidence of one deal, checks it and writes a Markdown report.
 * The tool signs nothing and sends no transaction.
 *
 * - The default deal is DEAL_CONTRACT_ID.
 * - Soroban RPC keeps the events for about 7 days. Run the tool on the day
 *   of the run and keep the bundle: `--bundle` writes the raw evidence, and
 *   `--from-bundle` builds the report again without the network.
 * - The exit code is 1 when a check fails.
 */
const USAGE =
  'Usage: pnpm deal:evidence [--deal C...] [--label <text>] [--compare-code C...,C...] ' +
  '[--deploy-log <file>] [--from-ledger N] [--account G...,G...] [--fixing 1=2209] ' +
  '[--bundle <file>] [--from-bundle <file>] [--out <file>]';

export interface EvidenceArguments {
  deal: string;
  label: string | null;
  compareDeals: string[];
  deployLog: string | null;
  fromLedger: number | null;
  accounts: string[];
  fixings: Record<number, bigint>;
  bundle: string | null;
  fromBundle: string | null;
  out: string | null;
}

function list(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

export function parseEvidenceArgs(argv: string[], defaultDeal: string): EvidenceArguments {
  const { values } = parseArgs({
    args: argv,
    options: {
      deal: { type: 'string' },
      label: { type: 'string' },
      'compare-code': { type: 'string' },
      'deploy-log': { type: 'string' },
      'from-ledger': { type: 'string' },
      account: { type: 'string' },
      fixing: { type: 'string' },
      bundle: { type: 'string' },
      'from-bundle': { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  const deal = values.deal ?? defaultDeal;
  const compareDeals = list(values['compare-code']);
  for (const contract of [deal, ...compareDeals]) {
    if (!StrKey.isValidContract(contract)) throw new Error(`${contract} is not a contract address (C...). ${USAGE}`);
  }
  const accounts = list(values.account);
  for (const account of accounts) {
    if (!StrKey.isValidEd25519PublicKey(account)) throw new Error(`${account} is not an account address (G...). ${USAGE}`);
  }
  let fromLedger: number | null = null;
  if (values['from-ledger'] !== undefined) {
    fromLedger = Number(values['from-ledger']);
    if (!Number.isInteger(fromLedger) || fromLedger < 1) throw new Error(`--from-ledger ${values['from-ledger']} is not a ledger number.`);
  }
  const fixings: Record<number, bigint> = {};
  for (const entry of list(values.fixing)) {
    const match = /^(\d+)=(-?\d+)$/.exec(entry);
    if (!match) throw new Error(`--fixing ${entry} is not <period>=<rate units>, for example 1=2209.`);
    fixings[Number(match[1])] = BigInt(match[2] as string);
  }
  return {
    deal,
    label: values.label ?? null,
    compareDeals,
    deployLog: values['deploy-log'] ?? null,
    fromLedger,
    accounts,
    fixings,
    bundle: values.bundle ?? null,
    fromBundle: values['from-bundle'] ?? null,
    out: values.out ?? null,
  };
}

const deployLogSchema = z.object({
  name: z.string().optional(),
  roles: z.object({ crank: z.string() }).optional(),
  transactions: z.array(z.object({ kind: z.string(), hash: z.string() })),
});

async function load(parsed: EvidenceArguments): Promise<Evidence> {
  if (parsed.fromBundle !== null) return fromBundle(await readFile(path.resolve(parsed.fromBundle), 'utf8'));
  let deployTransactions: CollectOptions['deployTransactions'] = [];
  let name: string | null = null;
  let crank: string | null = null;
  if (parsed.deployLog !== null) {
    const log = deployLogSchema.parse(JSON.parse(await readFile(path.resolve(parsed.deployLog), 'utf8')));
    deployTransactions = log.transactions;
    name = log.name ?? null;
    crank = log.roles?.crank ?? null;
  }
  return collectEvidence(
    {
      server,
      read: readContract,
      codeHashOf: wasmHashOf,
      networkPassphrase: environment.NETWORK_PASSPHRASE,
      horizonUrl: environment.HORIZON_URL,
    },
    {
      deal: parsed.deal,
      label: parsed.label ?? name ?? `Deal ${parsed.deal}`,
      network: environment.NETWORK_PASSPHRASE === Networks.PUBLIC ? 'mainnet' : 'testnet',
      compareDeals: parsed.compareDeals,
      fromLedger: parsed.fromLedger,
      deployTransactions,
      crank,
      accounts: parsed.accounts,
      fixings: parsed.fixings,
    },
  );
}

async function main(): Promise<void> {
  const parsed = parseEvidenceArgs(scriptArguments(), environment.DEAL_CONTRACT_ID);
  const evidence = await load(parsed);
  if (parsed.bundle !== null) {
    await writeFile(path.resolve(parsed.bundle), toBundle(evidence));
    console.error(`[deal:evidence] bundle written to ${path.resolve(parsed.bundle)}`);
  }
  const checks = runChecks(evidence);
  const report = renderReport(evidence, checks);
  if (parsed.out !== null) {
    await writeFile(path.resolve(parsed.out), report);
    console.error(`[deal:evidence] report written to ${path.resolve(parsed.out)}`);
  } else {
    console.log(report);
  }
  for (const check of checks) {
    console.error(`[deal:evidence] ${check.status.toUpperCase().padEnd(4)} ${check.id} ${check.title}`);
  }
  if (!allPassed(checks)) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) runCli(main);
