import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/lib/chunk.js';

describe('chunkText', () => {
  it('returns an empty array for an empty or blank text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps a short text as a single chunk', () => {
    const chunks = chunkText('One short sentence.');
    expect(chunks).toEqual(['One short sentence.']);
  });

  it('cuts a long text into several overlapping chunks', () => {
    const paragraph = 'This is a test sentence that fills the text up. ';
    const longText = paragraph.repeat(80);
    const chunks = chunkText(longText);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1300);
    }
    // The overlap puts the start of the next chunk at the end of the previous one.
    const firstChunk = chunks[0] ?? '';
    const secondChunkStart = (chunks[1] ?? '').slice(0, 50);
    expect(firstChunk.includes(secondChunkStart)).toBe(true);
  });

  it('normalizes the line endings and the repeated blank lines', () => {
    const chunks = chunkText('a\r\n\r\n\r\n\r\nb');
    expect(chunks).toEqual(['a\n\nb']);
  });
});
