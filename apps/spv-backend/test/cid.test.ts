import { describe, expect, it } from 'vitest';
import { cidOf, cidOfJson, canonicalJsonBytes } from '../src/ipfs/cid.js';

describe('local CID computation', () => {
  it('produces a CIDv1 raw (bafkrei...) form', async () => {
    const cid = await cidOf(new TextEncoder().encode('hello TrueABS'));
    expect(cid.startsWith('bafkrei')).toBe(true);
  });

  it('is deterministic for the same JSON regardless of key order', async () => {
    const a = await cidOfJson({ b: 2, a: 1, nested: { y: 2, x: 1 } });
    const b = await cidOfJson({ a: 1, nested: { x: 1, y: 2 }, b: 2 });
    expect(a.cid).toBe(b.cid);
  });

  it('changes when the content changes', async () => {
    const a = await cidOfJson({ vin: 'VF1AG0005PD104217' });
    const b = await cidOfJson({ vin: 'VF1AG0005PD104218' });
    expect(a.cid).not.toBe(b.cid);
  });

  it('matches the known CID of a fixed payload (cross-checked with ipfs add)', async () => {
    // "hello world" single raw block: well-known CIDv1
    const cid = await cidOf(new TextEncoder().encode('hello world'));
    expect(cid).toBe('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
  });

  it('rejects payloads over the single-block limit', async () => {
    await expect(cidOf(new Uint8Array(256 * 1024))).rejects.toThrow('256 KiB');
  });

  it('canonicalizes nested keys', () => {
    const bytes = canonicalJsonBytes({ z: { b: 1, a: 2 }, a: 0 });
    expect(new TextDecoder().decode(bytes)).toBe('{"a":0,"z":{"a":2,"b":1}}');
  });
});
