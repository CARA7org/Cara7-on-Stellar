const TARGET_LENGTH = 1200;
const OVERLAP_LENGTH = 150;

/**
 * Cut a text into overlapping chunks of about TARGET_LENGTH characters,
 * preferably breaking on a paragraph or on a sentence.
 */
export function chunkText(text: string): string[] {
  const cleanText = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleanText) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < cleanText.length) {
    let end = Math.min(start + TARGET_LENGTH, cleanText.length);
    if (end < cleanText.length) {
      const slice = cleanText.slice(start, end);
      const breakAt = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
      if (breakAt > TARGET_LENGTH * 0.5) end = start + breakAt + 1;
    }
    const piece = cleanText.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= cleanText.length) break;
    start = Math.max(end - OVERLAP_LENGTH, start + 1);
  }
  return chunks;
}
