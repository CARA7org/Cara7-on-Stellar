import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../paths.js';

/**
 * Registry of minted NFTs - a versioned JSON file (no database): the truth
 * lives on-chain, this file is the tokenId <-> VIN <-> CID <-> contract index.
 */
export interface MintedToken {
  tokenType: 'auto' | 'battery' | 'obligor' | 'pool';
  contractId: string;
  tokenId: number;
  vin: string | null;
  cid: string;
  tokenUri: string;
  txHash: string;
}

export interface NftRegistry {
  network: string;
  admin: string;
  mintedAt: string;
  contracts: Record<'auto' | 'battery' | 'obligor' | 'pool', string>;
  tokens: MintedToken[];
}

const REGISTRY_PATH = path.join(projectRoot, 'src', 'tokens', 'registry.json');

export function loadRegistry(): NftRegistry | null {
  if (!existsSync(REGISTRY_PATH)) return null;
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as NftRegistry;
}

export function saveRegistry(registry: NftRegistry): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
}
