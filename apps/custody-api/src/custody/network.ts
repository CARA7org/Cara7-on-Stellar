import { Networks } from '@stellar/stellar-sdk';
import type { StellarNetwork } from '../policy/policy.js';

export type DfnsStellarNetwork = 'StellarTestnet' | 'Stellar';

export function dfnsNetworkFor(network: StellarNetwork): DfnsStellarNetwork {
  return network === 'testnet' ? 'StellarTestnet' : 'Stellar';
}

/// Maps a Dfns network name to a Stellar passphrase. Other names give null.
export function passphraseForDfnsNetwork(network: string): string | null {
  if (network === 'StellarTestnet') return Networks.TESTNET;
  if (network === 'Stellar') return Networks.PUBLIC;
  return null;
}
