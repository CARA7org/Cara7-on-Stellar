import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

// The client turns these markers into <mark>, after it escapes the HTML.
export const HIGHLIGHT_OPEN = '\u0001';
export const HIGHLIGHT_CLOSE = '\u0002';

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

interface SearchRow {
  documentId: number;
  seq: number;
  filename: string;
  snippet: string;
  rank: number;
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/search', async (request, reply) => {
    const parseResult = searchQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Parameter q is required (1 to 200 characters)' });
    }
    const { q, limit } = parseResult.data;
    const headlineOptions =
      `StartSel="${HIGHLIGHT_OPEN}", StopSel="${HIGHLIGHT_CLOSE}", MaxFragments=2, MaxWords=18, MinWords=6`;
    const rows = await prisma.$queryRaw<SearchRow[]>`
      SELECT chunks.document_id AS "documentId",
             chunks.seq,
             documents.filename,
             ts_headline('french', chunks.content, websearch_to_tsquery('french', ${q}), ${headlineOptions}) AS snippet,
             ts_rank(chunks.search_vector, websearch_to_tsquery('french', ${q}))::float8 AS rank
        FROM chunks
        JOIN documents ON documents.id = chunks.document_id
       WHERE chunks.search_vector @@ websearch_to_tsquery('french', ${q})
       ORDER BY rank DESC
       LIMIT ${limit}`;

    // One result per document: keep the best passages of each one.
    const byDocument = new Map<number, { documentId: number; filename: string; snippets: string[]; matches: number }>();
    for (const row of rows) {
      const entry = byDocument.get(row.documentId);
      if (!entry) {
        byDocument.set(row.documentId, {
          documentId: row.documentId,
          filename: row.filename,
          snippets: [row.snippet],
          matches: 1,
        });
      } else {
        entry.matches += 1;
        if (entry.snippets.length < 3) entry.snippets.push(row.snippet);
      }
    }
    return { results: [...byDocument.values()] };
  });

  app.get('/api/stats', async () => {
    const documentAggregate = await prisma.document.aggregate({ _count: true, _sum: { size: true } });
    const chunkCount = await prisma.chunk.count();
    return {
      documents: documentAggregate._count,
      chunks: chunkCount,
      bytes: documentAggregate._sum.size ?? 0,
    };
  });
}
