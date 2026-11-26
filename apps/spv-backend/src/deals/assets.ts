import { Networks } from '@stellar/stellar-sdk';
import type { StellarNetwork } from '../custody/ports.js';

/**
 * The closed list of settlement assets. A deal settles in one of these
 * assets, through its Stellar Asset Contract (SAC). The notes are
 * denominated in EUR and settle at par in the asset. `pnpm deal:deploy`
 * refuses an asset that is not in the list of its network.
 *
 * The SAC id is a function of the asset and the network passphrase. A unit
 * test checks each `sac` against `new Asset(code, issuer).contractId(...)`.
 */
export const DEAL_NETWORKS = ['testnet', 'mainnet'] as const;
export type DealNetwork = (typeof DEAL_NETWORKS)[number];

export const NETWORK_PASSPHRASE: Record<DealNetwork, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

export interface SettlementAsset {
  code: string;
  issuer: string;
  /** The contract id of the Stellar Asset Contract of `code:issuer`. */
  sac: string;
  label: string;
}

export const SETTLEMENT_ASSETS: Record<DealNetwork, readonly SettlementAsset[]> = {
  testnet: [
    {
      code: 'EURC',
      issuer: 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO',
      sac: 'CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ',
      label: 'Circle EURC (testnet)',
    },
    {
      // CARA7 issues this asset itself. The client demo deals use it.
      code: 'EURC',
      issuer: 'GCB6FLVHX7OXWSUHP76WGPVOJLGPB6FGXAQKMVSWPNP6NFUWNOHQMXQA',
      sac: 'CBEO2RDQKBM7S3TYOYKBWAJEC6WMYPCW6JJWX47UCLFMUJI2EUZPJOXW',
      label: 'CARA7 test EURC (self-issued, client demo deals)',
    },
  ],
  // These mainnet ids come from research. Before a mainnet deal, check each
  // issuer and each contract id at the source (the documentation of the
  // issuer). The unit test proves only that each SAC id matches its asset.
  mainnet: [
    {
      code: 'EURC',
      issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
      sac: 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
      label: 'Circle EURC',
    },
    {
      code: 'EURCV',
      issuer: 'GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G',
      sac: 'CANKBYNNAYKEZXLB655F2UPNTAZFK5HILZUXL7ZTFR3NF6LKDSVY7KFH',
      label: 'SG-FORGE EURCV',
    },
  ],
};

/** The network name of a passphrase, or null for another network. */
export function networkOfPassphrase(passphrase: string): DealNetwork | null {
  return DEAL_NETWORKS.find((network) => NETWORK_PASSPHRASE[network] === passphrase) ?? null;
}

export function findSettlementAsset(network: DealNetwork, sac: string): SettlementAsset | undefined {
  return SETTLEMENT_ASSETS[network].find((asset) => asset.sac === sac);
}

/** The listed asset with this SAC id. An asset outside the list gives an error. */
export function settlementAsset(network: DealNetwork, sac: string): SettlementAsset {
  const asset = findSettlementAsset(network, sac);
  if (asset) return asset;
  const allowed = SETTLEMENT_ASSETS[network].map((entry) => `${entry.sac} (${entry.label})`);
  throw new Error(
    `The asset ${sac} is not a settlement asset of ${network}. Use one of: ${allowed.join(', ')}.`,
  );
}

/** What the asset contract says about itself. */
export interface AssetInfo {
  contractId: string;
  /** For a SAC: "CODE:ISSUER", or "native" for XLM. */
  name: string;
  symbol: string;
  decimals: number;
}

/** Reads name(), symbol() and decimals() of a SEP-41 asset contract. */
export async function readAssetInfo(
  read: StellarNetwork['read'],
  contractId: string,
): Promise<AssetInfo> {
  const [name, symbol, decimals] = await Promise.all([
    read(contractId, 'name'),
    read(contractId, 'symbol'),
    read(contractId, 'decimals'),
  ]);
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 18) {
    throw new Error(`The asset ${contractId} gives ${String(decimals)} decimals. 0 to 18 expected.`);
  }
  return { contractId, name: String(name), symbol: String(symbol), decimals: places };
}
