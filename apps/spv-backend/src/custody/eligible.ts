import { parseArgs } from 'node:util';
import { StrKey, xdr } from '@stellar/stellar-sdk';
import { addressArg } from '../waterfall/soroban.js';
import { isMainModule, runCli, scriptArguments } from './cli.js';
import type { OperatorRequest } from './operator.js';
import { defaultOperatorServices } from './services.js';
import { runAndWait } from './wait.js';

/**
 * pnpm deal:eligible --deal C... --add G...,G...
 * pnpm deal:eligible --deal C... --remove G...,G...
 *
 * The admin role signs `set_eligible` on the deal. Only an investor on the
 * whitelist can subscribe, and a note transfer needs a receiver on the
 * whitelist. A holder that the admin removes keeps its notes and is still
 * paid. Only a deal of the new contract code has a whitelist.
 */
const USAGE = 'Usage: pnpm deal:eligible --deal C... (--add G...,G... | --remove G...,G...)';

/** Holders in one `set_eligible` transaction. Each holder writes one ledger entry. */
export const ELIGIBLE_BATCH = 20;

export interface EligibleChange {
  deal: string;
  holders: string[];
  eligible: boolean;
}

/** A comma-separated list of distinct account addresses (G...). */
export function parseHolders(list: string, option: string): string[] {
  const holders = list
    .split(',')
    .map((holder) => holder.trim())
    .filter((holder) => holder.length > 0);
  if (holders.length === 0) throw new Error(`${option} needs at least one account address. ${USAGE}`);
  const seen = new Set<string>();
  for (const holder of holders) {
    if (!StrKey.isValidEd25519PublicKey(holder)) {
      throw new Error(`${option} ${holder} is not an account address (G...).`);
    }
    if (seen.has(holder)) throw new Error(`${option} names ${holder} two times.`);
    seen.add(holder);
  }
  return holders;
}

export function parseEligible(argv: string[]): EligibleChange {
  const { values } = parseArgs({
    args: argv,
    options: {
      deal: { type: 'string' },
      add: { type: 'string' },
      remove: { type: 'string' },
    },
    strict: true,
  });
  const deal = values.deal;
  if (!deal) throw new Error(`--deal is missing. ${USAGE}`);
  if (!StrKey.isValidContract(deal)) throw new Error(`--deal ${deal} is not a contract address (C...).`);
  if ((values.add === undefined) === (values.remove === undefined)) {
    throw new Error(`Give --add or --remove (one of them). ${USAGE}`);
  }
  if (values.add !== undefined) {
    return { deal, holders: parseHolders(values.add, '--add'), eligible: true };
  }
  return { deal, holders: parseHolders(values.remove ?? '', '--remove'), eligible: false };
}

/** One admin request for each batch of at most ELIGIBLE_BATCH holders. */
export function eligibleRequests(change: EligibleChange): OperatorRequest[] {
  const requests: OperatorRequest[] = [];
  for (let start = 0; start < change.holders.length; start += ELIGIBLE_BATCH) {
    const batch = change.holders.slice(start, start + ELIGIBLE_BATCH);
    requests.push({
      kind: change.eligible ? 'add-eligible' : 'remove-eligible',
      role: 'admin',
      call: {
        type: 'contract',
        contractId: change.deal,
        method: 'set_eligible',
        args: [xdr.ScVal.scvVec(batch.map(addressArg)), xdr.ScVal.scvBool(change.eligible)],
      },
    });
  }
  return requests;
}

async function main(): Promise<void> {
  const change = parseEligible(scriptArguments());
  const { operator, network } = defaultOperatorServices();
  const admin = await operator.resolve('admin');
  const action = change.eligible ? 'adds' : 'removes';
  const count = change.holders.length;
  console.log(`[deal:eligible] admin ${admin.address} ${action} ${count} holder(s) on ${change.deal}`);
  for (const request of eligibleRequests(change)) {
    const done = await runAndWait(operator, request);
    console.log(`[deal:eligible] set_eligible done (tx ${done.hash})`);
  }
  for (const holder of change.holders) {
    const eligible = await network.read(change.deal, 'is_eligible', [addressArg(holder)]);
    console.log(`  ${holder}  eligible: ${String(eligible)}`);
  }
}

if (isMainModule(import.meta.url)) runCli(main);
