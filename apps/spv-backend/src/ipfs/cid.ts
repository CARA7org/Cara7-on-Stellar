import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';

/**
 * Authentic CIDv1 (raw codec + sha2-256, `bafkrei...` form): identical to the
 * CID `ipfs add --cid-version=1` or Pinata (cidVersion: 1) would produce for
 * the same bytes, as long as the content fits in a single block (< 256 KiB).
 * Our metadata is ~2-5 KB: guaranteed. See asset-pool/README.md (sources).
 */
const SINGLE_BLOCK_LIMIT = 256 * 1024;

export async function cidOf(bytes: Uint8Array): Promise<string> {
  if (bytes.length >= SINGLE_BLOCK_LIMIT) {
    throw new Error('Content > 256 KiB: a single-block CID would no longer match ipfs add');
  }
  const digest = await sha256.digest(bytes);
  return CID.createV1(raw.code, digest).toString();
}

/// Canonical JSON (sorted keys) so the same object always yields the same CID.
export function canonicalJsonBytes(value: unknown): Uint8Array {
  const sorted = JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return entry as unknown;
  });
  return new TextEncoder().encode(sorted);
}

export async function cidOfJson(value: unknown): Promise<{ cid: string; bytes: Uint8Array }> {
  const bytes = canonicalJsonBytes(value);
  return { cid: await cidOf(bytes), bytes };
}
