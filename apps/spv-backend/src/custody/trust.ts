import { parseArgs } from 'node:util';
import { Asset, Operation } from '@stellar/stellar-sdk';
import { environment, type Environment } from '../config.js';
import { readContract } from '../waterfall/soroban.js';
import { isMainModule, runCli, scriptArguments } from './cli.js';
import type { OperatorRequest } from './operator.js';
import { OPERATOR_ROLES, isOperatorRole, type OperatorRole, type StellarNetwork } from './ports.js';
import { defaultOperatorServices } from './services.js';
import { runAndWait } from './wait.js';

/**
 * pnpm custody:trust --role <admin|servicer|reporter|crank> [--remove]
 *
 * The role wallet signs a classic ChangeTrust for the deal asset, and
 * Horizon receives it. The servicer needs this trustline: `distribute`
 * transfers the collections from the servicer to the deal. `--remove` sets
 * the limit to 0, which removes a trustline with a zero balance.
 *
 * The script reads the asset of the deal (DEAL_CONTRACT_ID). The asset
 * contract is a Stellar Asset Contract, and its name() is "CODE:ISSUER".
 * EURC_CODE and EURC_ISSUER override that asset when both are set.
 */
const USAGE = `Usage: pnpm custody:trust --role <${OPERATOR_ROLES.join('|')}> [--remove]`;

type TrustSettings = Pick<
  Environment,
  'EURC_CODE' | 'EURC_ISSUER' | 'DEAL_CONTRACT_ID' | 'NETWORK_PASSPHRASE'
>;

/** The asset that EURC_CODE and EURC_ISSUER set, or null when neither is set. */
export function assetOverride(settings: Pick<Environment, 'EURC_CODE' | 'EURC_ISSUER'>): Asset | null {
  const { EURC_CODE: code, EURC_ISSUER: issuer } = settings;
  if (!code && !issuer) return null;
  if (!code || !issuer) throw new Error('Set both EURC_CODE and EURC_ISSUER, or neither of them.');
  return new Asset(code, issuer);
}

/**
 * The classic asset of a Stellar Asset Contract, from its name()
 * "CODE:ISSUER". The SAC id must match that asset on this network.
 */
export function classicAssetOfSac(name: string, sacId: string, networkPassphrase: string): Asset {
  if (name === 'native') {
    throw new Error(`The asset contract ${sacId} is XLM. XLM needs no trustline.`);
  }
  const match = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(name);
  if (!match?.[1] || !match[2]) {
    throw new Error(
      `The asset contract ${sacId} has the name "${name}". A Stellar Asset Contract has the name CODE:ISSUER.`,
    );
  }
  const asset = new Asset(match[1], match[2]);
  if (asset.contractId(networkPassphrase) !== sacId) {
    throw new Error(`The asset contract ${sacId} is not the Stellar Asset Contract of ${name}.`);
  }
  return asset;
}

/** The asset of the trustline: the override, or the classic asset of the deal asset contract. */
export async function trustAsset(
  read: StellarNetwork['read'] = readContract,
  settings: TrustSettings = environment,
): Promise<Asset> {
  const override = assetOverride(settings);
  if (override) return override;
  const config = (await read(settings.DEAL_CONTRACT_ID, 'get_config')) as { asset: string };
  const name = String(await read(config.asset, 'name'));
  return classicAssetOfSac(name, config.asset, settings.NETWORK_PASSPHRASE);
}

export function parseTrust(argv: string[]): { role: OperatorRole; remove: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: { role: { type: 'string' }, remove: { type: 'boolean', default: false } },
    strict: true,
  });
  const role = values.role ?? '';
  if (!isOperatorRole(role)) throw new Error(`--role is missing or unknown. ${USAGE}`);
  return { role, remove: values.remove ?? false };
}

export function trustRequest(role: OperatorRole, asset: Asset, remove: boolean): OperatorRequest {
  return {
    kind: 'change-trust',
    role,
    call: {
      type: 'classic',
      method: 'change_trust',
      operation: Operation.changeTrust(remove ? { asset, limit: '0' } : { asset }),
    },
  };
}

async function main(): Promise<void> {
  const { role, remove } = parseTrust(scriptArguments());
  const asset = await trustAsset();
  const { operator } = defaultOperatorServices();
  const wallet = await operator.resolve(role);
  const action = remove ? 'removes' : 'adds';
  const line = `${asset.getCode()}:${asset.getIssuer()}`;
  console.log(`[custody:trust] ${role} ${wallet.address} ${action} the trustline ${line}`);
  const done = await runAndWait(operator, trustRequest(role, asset, remove));
  console.log(`[custody:trust] done (tx ${done.hash})`);
  console.log(`https://stellar.expert/explorer/testnet/tx/${done.hash}`);
}

if (isMainModule(import.meta.url)) runCli(main);
