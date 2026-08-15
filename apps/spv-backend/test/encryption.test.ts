import { beforeAll, describe, expect, it } from 'vitest';

// The key must exist before config.ts is imported by the module under test.
const TEST_KEY = 'a'.repeat(64);
process.env.METADATA_ENCRYPTION_KEY = TEST_KEY;

const { sealConfidential, openConfidential } = await import('../src/ipfs/encryption.js');
const { obligorTokenMetadata } = await import('../src/tokens/metadata.js');
const { loadPool } = await import('../src/asset-pool/pool.js');

describe('metadata encryption (AES-256-GCM)', () => {
  const confidential = {
    creditScoreBand: 'B',
    currentPrincipalEur: 14_250.5,
    daysPastDue: 0,
  };

  it('seal then open round-trips the confidential object', () => {
    const sealed = sealConfidential({ name: 'doc', confidential });
    expect(sealed).not.toHaveProperty('confidential');
    expect(sealed.sealed?.algorithm).toBe('AES-256-GCM');
    expect(openConfidential(sealed.sealed!)).toEqual(confidential);
  });

  it('keeps the public part in clear and unchanged', () => {
    const sealed = sealConfidential({ name: 'doc', vin: 'WVWZZZ', confidential });
    expect(sealed.name).toBe('doc');
    expect(sealed.vin).toBe('WVWZZZ');
    const json = JSON.stringify(sealed);
    expect(json).not.toContain('creditScoreBand');
    expect(json).not.toContain('14250.5');
  });

  it('is a no-op for documents without a confidential section', () => {
    const sealed = sealConfidential({ name: 'public-only', attributes: [] });
    expect(sealed).toEqual({ name: 'public-only', attributes: [] });
  });

  it('rejects tampered ciphertext (GCM auth)', () => {
    const sealed = sealConfidential({ confidential });
    const bytes = Buffer.from(sealed.sealed!.ciphertext, 'base64');
    bytes[0] = bytes[0] ^ 0xff;
    const tampered = { ...sealed.sealed!, ciphertext: bytes.toString('base64') };
    expect(() => openConfidential(tampered)).toThrow();
  });

  it('produces a fresh iv (and ciphertext) on every seal', () => {
    const first = sealConfidential({ confidential });
    const second = sealConfidential({ confidential });
    expect(first.sealed!.iv).not.toBe(second.sealed!.iv);
    expect(first.sealed!.ciphertext).not.toBe(second.sealed!.ciphertext);
  });

  it('obligor token metadata publishes no loan-level fields in clear', () => {
    const pool = loadPool();
    const metadata = obligorTokenMetadata(pool.vehicles[0]!);
    // The builder declares them confidential...
    expect(metadata.confidential).toMatchObject({
      creditScoreBand: expect.any(String),
      daysPastDue: expect.any(Number),
    });
    // ...and the public attributes carry only identity + geography.
    const traits = metadata.attributes.map((attribute) => attribute.trait_type);
    expect(traits).toEqual(['Obligor ID', 'Country', 'Geographic Region']);
    const sealedJson = JSON.stringify(sealConfidential(metadata));
    expect(sealedJson).not.toContain('Credit Score');
    expect(sealedJson).not.toContain('creditScoreBand');
  });
});
