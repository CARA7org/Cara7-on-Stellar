import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ipfsStoreDirectory } from '../paths.js';
import { cidOfJson } from './cid.js';
import { sealConfidential } from './encryption.js';

/**
 * Local content-addressed store: one file per CID under src/ipfs/store/.
 * This is the diagram's IPFS box, served by gateway.ts; real pinning (pin.ts)
 * can republish these exact bytes later with identical CIDs.
 */
/**
 * Store a metadata document, sealing its `confidential` section first (the
 * single choke point of metadata encryption - see ipfs/encryption.ts).
 */
export async function putMetadata(value: Record<string, unknown>): Promise<string> {
  return putJson(sealConfidential(value));
}

export async function putJson(value: unknown): Promise<string> {
  mkdirSync(ipfsStoreDirectory, { recursive: true });
  const { cid, bytes } = await cidOfJson(value);
  writeFileSync(path.join(ipfsStoreDirectory, cid), bytes);
  return cid;
}

export function getBytes(cid: string): Buffer | null {
  const filePath = path.join(ipfsStoreDirectory, path.basename(cid));
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath);
}

export function listCids(): string[] {
  if (!existsSync(ipfsStoreDirectory)) return [];
  return readdirSync(ipfsStoreDirectory).filter((name) => name.startsWith('baf'));
}
