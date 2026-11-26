import { Networks, type Asset } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { environment } from '../config.js';
import { readContract } from '../waterfall/soroban.js';
import { isMainModule, runCli } from './cli.js';
import { errorMessage } from './errors.js';
import { OPERATOR_ROLES, type OperatorRole } from './ports.js';
import { defaultOperatorServices } from './services.js';
import { trustAsset } from './trust.js';

/**
 * pnpm custody:status - read-only.
 *
 * For each operator role: the wallet (Dfns or a Stellar CLI identity, see
 * OPERATOR_SIGNER), its address, its XLM balance and its trustline to the
 * deal asset. Then the on-chain bindings: the deal admin and servicer, the
 * oracle admin and reporter, against the operator addresses. The oracle is
 * the oracle of the deal (`get_config`), not the setting. Then the role
 * separation: the admin, the servicer and the reporter are three addresses.
 * The script sends no transaction and calls no faucet.
 */
const horizonAccountSchema = z.object({
  balances: z.array(
    z.object({
      asset_type: z.string(),
      asset_code: z.string().optional(),
      asset_issuer: z.string().optional(),
      balance: z.string(),
    }),
  ),
});

type HorizonAccount = z.infer<typeof horizonAccountSchema>;
type Addresses = Partial<Record<OperatorRole, string>>;

const { operator } = defaultOperatorServices();

async function loadHorizonAccount(address: string): Promise<HorizonAccount | null> {
  const response = await fetch(`${environment.HORIZON_URL}/accounts/${address}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Horizon answered HTTP ${response.status}.`);
  return horizonAccountSchema.parse(await response.json());
}

function balanceLines(account: HorizonAccount, asset: Asset | null): string[] {
  const xlm = account.balances.find((balance) => balance.asset_type === 'native');
  const lines = [`  XLM       ${xlm?.balance ?? '0'}`];
  if (!asset) return lines;
  const held = account.balances.find(
    (balance) => balance.asset_code === asset.getCode() && balance.asset_issuer === asset.getIssuer(),
  );
  const code = asset.getCode().padEnd(9);
  lines.push(
    held
      ? `  ${code} trustline, balance ${held.balance}`
      : `  ${code} no trustline (pnpm custody:trust)`,
  );
  return lines;
}

async function accountLines(address: string, asset: Asset | null): Promise<string[]> {
  const account = await loadHorizonAccount(address);
  if (account) return balanceLines(account, asset);
  if (environment.NETWORK_PASSPHRASE !== Networks.TESTNET) return ['  account   not found'];
  return [
    '  account   not on testnet. Fund it:',
    `            https://friendbot.stellar.org/?addr=${address}`,
  ];
}

async function printRole(role: OperatorRole, addresses: Addresses, asset: Asset | null): Promise<void> {
  console.log(role);
  try {
    const wallet = await operator.resolve(role);
    addresses[role] = wallet.address;
    console.log(`  wallet    ${wallet.walletId}`);
    console.log(`  address   ${wallet.address}`);
    for (const line of await accountLines(wallet.address, asset)) console.log(line);
  } catch (error) {
    console.log(`  ${errorMessage(error)}`);
  }
}

function compare(label: string, onChain: string, role: OperatorRole, addresses: Addresses): void {
  const expected = addresses[role];
  let verdict = `UNKNOWN (no ${role} wallet)`;
  if (expected) verdict = onChain === expected ? 'MATCH' : 'DIFFERENT';
  console.log(`  ${label.padEnd(16)} ${onChain}  ${verdict}`);
  if (expected && onChain !== expected) console.log(`  ${''.padEnd(16)} operator ${role}: ${expected}`);
}

/** The verdict of the role separation that the contract enforces. */
export function roleSeparation(roles: { admin: string; servicer: string; reporter: string | null }): string {
  const { admin, servicer, reporter } = roles;
  if (admin === servicer) return 'CONFLICT: the admin is the servicer';
  if (reporter !== null && reporter === admin) return 'CONFLICT: the reporter of the oracle is the admin';
  if (reporter !== null && reporter === servicer) return 'CONFLICT: the reporter of the oracle is the servicer';
  return reporter === null ? 'admin and servicer are two addresses (reporter not read)' : 'OK: three addresses';
}

async function printBindings(addresses: Addresses): Promise<void> {
  console.log('\nOn-chain bindings');
  let dealRoles: { admin: string; servicer: string } | null = null;
  let oracle = environment.RATE_ORACLE_CONTRACT_ID;
  try {
    const config = (await readContract(environment.DEAL_CONTRACT_ID, 'get_config')) as {
      admin: string;
      servicer: string;
      oracle: string;
    };
    dealRoles = { admin: config.admin, servicer: config.servicer };
    compare('deal admin', config.admin, 'admin', addresses);
    compare('deal servicer', config.servicer, 'servicer', addresses);
    if (config.oracle !== oracle) {
      console.log(`  WARNING: the deal reads the oracle ${config.oracle}.`);
      console.log(`  ${''.padEnd(9)}RATE_ORACLE_CONTRACT_ID is ${oracle}: set it to the oracle of the deal.`);
      oracle = config.oracle;
    }
  } catch (error) {
    console.log(`  deal ${environment.DEAL_CONTRACT_ID}: ${errorMessage(error)}`);
  }
  let reporter: string | null = null;
  try {
    const oracleAdmin = (await readContract(oracle, 'get_admin')) as string;
    reporter = (await readContract(oracle, 'get_reporter')) as string;
    compare('oracle admin', oracleAdmin, 'admin', addresses);
    compare('oracle reporter', reporter, 'reporter', addresses);
  } catch (error) {
    console.log(`  oracle ${oracle}: ${errorMessage(error)}`);
  }
  if (dealRoles) console.log(`  ${'role separation'.padEnd(16)} ${roleSeparation({ ...dealRoles, reporter })}`);
}

async function main(): Promise<void> {
  const signer = environment.OPERATOR_SIGNER;
  console.log(`Operator custody status (${signer}, ${environment.NETWORK_PASSPHRASE})\n`);
  let asset: Asset | null = null;
  try {
    asset = await trustAsset();
  } catch (error) {
    console.log(`Deal asset: ${errorMessage(error)}\n`);
  }
  const addresses: Addresses = {};
  for (const role of OPERATOR_ROLES) await printRole(role, addresses, asset);
  await printBindings(addresses);
}

if (isMainModule(import.meta.url)) runCli(main);
