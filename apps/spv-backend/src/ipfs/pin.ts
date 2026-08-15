import { environment } from '../config.js';

/**
 * Optional pinning to Pinata. Our local CIDs (raw + sha2-256, v1) are
 * identical to what Pinata produces with cidVersion: 1 for the same bytes,
 * so republishing never changes any on-chain URI. Without PINATA_JWT this
 * function is a deliberate no-op (local gateway only).
 */
export async function pinBytes(bytes: Uint8Array, name: string): Promise<'pinned' | 'skipped'> {
  if (!environment.PINATA_JWT) return 'skipped';
  const body = new FormData();
  body.append('file', new Blob([Buffer.from(bytes)], { type: 'application/json' }), name);
  body.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
  const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${environment.PINATA_JWT}` },
    body,
  });
  if (!response.ok) throw new Error(`Pinata rejected ${name}: ${response.status}`);
  return 'pinned';
}
