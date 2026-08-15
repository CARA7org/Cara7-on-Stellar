import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { canonicalJsonBytes } from './cid.js';
import { environment } from '../config.js';

/**
 * Confidential-metadata sealing, deliberately minimal to stay maintainable:
 *
 * - ONE deal-level symmetric key (METADATA_ENCRYPTION_KEY, 32 bytes hex),
 *   AES-256-GCM from node:crypto - no dependency, no key server.
 * - A metadata document may carry a `confidential` object. `seal()` replaces
 *   it with a `sealed` envelope {algorithm, iv, ciphertext, tag}; everything
 *   else stays public cleartext. The CID then addresses the envelope, so the
 *   Pool Token references and integrity checks work unchanged - the content
 *   is simply opaque.
 * - GDPR erasure on immutable storage = crypto-shredding: destroying the key
 *   makes every sealed section unreadable forever.
 *
 * NOT here on purpose: per-audience keys, rotation, asymmetric envelopes.
 * The day a real loan tape needs per-role disclosure, this module is the one
 * choke point to extend.
 */

export const SEALED_ALGORITHM = 'AES-256-GCM';

export interface SealedSection {
  algorithm: typeof SEALED_ALGORITHM;
  iv: string; // base64, 12 bytes
  ciphertext: string; // base64
  tag: string; // base64, 16-byte GCM auth tag
}

function encryptionKey(): Buffer | null {
  const hex = environment.METADATA_ENCRYPTION_KEY;
  return hex ? Buffer.from(hex, 'hex') : null;
}

export function encryptionConfigured(): boolean {
  return encryptionKey() != null;
}

/**
 * Seal the `confidential` section of a metadata document, if present.
 * Throws when a confidential section exists but no key is configured -
 * silently publishing sensitive fields in clear would be worse than failing.
 */
export function sealConfidential<T extends Record<string, unknown>>(
  metadata: T
): Omit<T, 'confidential'> & { sealed?: SealedSection } {
  const { confidential, ...publicPart } = metadata;
  if (confidential == null) return publicPart;
  const key = encryptionKey();
  if (!key) {
    throw new Error(
      'Metadata has a confidential section but METADATA_ENCRYPTION_KEY is not set (generate one: openssl rand -hex 32)'
    );
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = canonicalJsonBytes(confidential);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ...publicPart,
    sealed: {
      algorithm: SEALED_ALGORITHM,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    },
  };
}

/**
 * Open a sealed section back into the original confidential object.
 * GCM authenticates: any tampering with iv/ciphertext/tag throws.
 */
export function openConfidential(sealed: SealedSection): Record<string, unknown> {
  const key = encryptionKey();
  if (!key) throw new Error('METADATA_ENCRYPTION_KEY is not set');
  if (sealed.algorithm !== SEALED_ALGORITHM) {
    throw new Error(`Unsupported sealed algorithm: ${sealed.algorithm}`);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>;
}
