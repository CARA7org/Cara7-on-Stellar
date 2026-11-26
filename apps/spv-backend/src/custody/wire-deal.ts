import { parseArgs } from 'node:util';
import { StrKey, xdr } from '@stellar/stellar-sdk';
import { addressArg } from '../waterfall/soroban.js';
import { isMainModule, runCli, scriptArguments } from './cli.js';
import type { OperatorRequest } from './operator.js';
import { defaultOperatorServices } from './services.js';
import { runAndWait } from './wait.js';

/**
 * pnpm deal:wire --deal C... --notes C...,C...,C... --paying-agent C...
 *
 * The admin wallet signs `set_wiring` on the deal: one note token for each
 * class, senior first, then the paying agent. The deal accepts the wiring
 * once. The admin policy asks a person to approve, so the script waits.
 */
const USAGE = 'Usage: pnpm deal:wire --deal C... --notes C...,C...,C... --paying-agent C...';

export interface Wiring {
  deal: string;
  notes: string[];
  payingAgent: string;
}

function contractAddress(value: string | undefined, name: string): string {
  if (!value) throw new Error(`--${name} is missing. ${USAGE}`);
  if (!StrKey.isValidContract(value)) {
    throw new Error(`--${name} ${value} is not a contract address (C...).`);
  }
  return value;
}

export function parseWiring(argv: string[]): Wiring {
  const { values } = parseArgs({
    args: argv,
    options: {
      deal: { type: 'string' },
      notes: { type: 'string' },
      'paying-agent': { type: 'string' },
    },
    strict: true,
  });
  const notes = (values.notes ?? '').split(',').filter((note) => note.length > 0);
  if (notes.length === 0) throw new Error(`--notes is missing. ${USAGE}`);
  return {
    deal: contractAddress(values.deal, 'deal'),
    notes: notes.map((note) => contractAddress(note, 'notes')),
    payingAgent: contractAddress(values['paying-agent'], 'paying-agent'),
  };
}

export function wiringRequest(wiring: Wiring): OperatorRequest {
  return {
    kind: 'set-wiring',
    role: 'admin',
    call: {
      type: 'contract',
      contractId: wiring.deal,
      method: 'set_wiring',
      args: [xdr.ScVal.scvVec(wiring.notes.map(addressArg)), addressArg(wiring.payingAgent)],
    },
  };
}

async function main(): Promise<void> {
  const wiring = parseWiring(scriptArguments());
  const { operator } = defaultOperatorServices();
  const admin = await operator.resolve('admin');
  const count = wiring.notes.length;
  console.log(`[deal:wire] admin ${admin.address} wires ${count} note tokens on ${wiring.deal}`);
  const done = await runAndWait(operator, wiringRequest(wiring));
  console.log(`[deal:wire] wired (tx ${done.hash})`);
}

if (isMainModule(import.meta.url)) runCli(main);
