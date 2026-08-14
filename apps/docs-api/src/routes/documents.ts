import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { filesDirectory } from '../paths.js';
import { chunkText } from '../lib/chunk.js';
import { extractText, isSupportedExtension } from '../lib/extract.js';

const identifierParamsSchema = z.object({ id: z.coerce.number().int().positive() });

interface UploadResult {
  ok: boolean;
  id?: number;
  filename: string;
  chunks?: number;
  chars?: number;
  error?: string;
}

async function indexFile(filename: string, storedPath: string, note: string): Promise<UploadResult> {
  const extraction = await extractText(storedPath, filename);
  const contentChunks = chunkText(extraction.text);
  if (contentChunks.length === 0) {
    throw new Error('No text extracted (empty document, or scanned without OCR)');
  }
  // The note typed at upload time is indexed as a chunk like the rest.
  const chunkContents = note ? [`Note: ${note}`, ...contentChunks] : contentChunks;
  const fileStat = await stat(storedPath);

  // A file of the same name replaces the previous version BUT KEEPS ITS ID:
  // callers store that id, so reassigning one on every re-upload would break
  // every reference to the document.
  const documentData = {
    storedPath,
    size: fileStat.size,
    pages: extraction.pages ?? null,
    chars: extraction.text.length,
    note: note || null,
    fullText: extraction.text,
  };
  const { document, previousPath } = await prisma.$transaction(async (transaction) => {
    const existing = await transaction.document.findUnique({ where: { filename } });
    if (existing) {
      await transaction.chunk.deleteMany({ where: { documentId: existing.id } });
      const updated = await transaction.document.update({
        where: { id: existing.id },
        data: documentData,
      });
      await transaction.chunk.createMany({
        data: chunkContents.map((content, seq) => ({ documentId: updated.id, seq, content })),
      });
      return { document: updated, previousPath: existing.storedPath };
    }
    const createdDocument = await transaction.document.create({
      data: { filename, ...documentData },
    });
    await transaction.chunk.createMany({
      data: chunkContents.map((content, seq) => ({ documentId: createdDocument.id, seq, content })),
    });
    return { document: createdDocument, previousPath: null };
  });

  if (previousPath && previousPath !== storedPath) await rm(previousPath, { force: true });
  return { ok: true, id: document.id, filename, chunks: chunkContents.length, chars: extraction.text.length };
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/upload', async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: 'Multipart request expected' });
    }
    const results: UploadResult[] = [];
    // The client sends the "note" field before the files.
    let note = '';
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'note') note = String(part.value ?? '').trim().slice(0, 2000);
        continue;
      }
      const filename = path.basename(part.filename);
      const extension = path.extname(filename).toLowerCase();
      if (!isSupportedExtension(extension)) {
        part.file.resume();
        results.push({ ok: false, filename, error: `Unsupported format: ${extension || '(no extension)'}` });
        continue;
      }
      const storedPath = path.join(filesDirectory, `${Date.now()}-${randomBytes(4).toString('hex')}${extension}`);
      try {
        await pipeline(part.file, createWriteStream(storedPath));
        if (part.file.truncated) {
          throw new Error('File too large (50 MB maximum)');
        }
        results.push(await indexFile(filename, storedPath, note));
      } catch (error) {
        await rm(storedPath, { force: true });
        const message = error instanceof Error ? error.message : String(error);
        results.push({ ok: false, filename, error: message });
      }
    }
    return { results };
  });

  app.get('/api/documents', async () => {
    const documents = await prisma.document.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { chunks: true } } },
    });
    return {
      documents: documents.map((document) => ({
        id: document.id,
        filename: document.filename,
        size: document.size,
        pages: document.pages,
        chars: document.chars,
        note: document.note,
        chunkCount: document._count.chunks,
        createdAt: document.createdAt,
      })),
    };
  });

  app.get('/api/documents/:id/file', async (request, reply) => {
    const parseResult = identifierParamsSchema.safeParse(request.params);
    if (!parseResult.success) return reply.status(400).send({ error: 'Invalid identifier' });
    const documentRecord = await prisma.document.findUnique({ where: { id: parseResult.data.id } });
    if (!documentRecord) return reply.status(404).send({ error: 'Document not found' });
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(documentRecord.filename)}`,
    );
    reply.type('application/octet-stream');
    return reply.send(createReadStream(documentRecord.storedPath));
  });

  app.get('/api/documents/:id/text', async (request, reply) => {
    const parseResult = identifierParamsSchema.safeParse(request.params);
    if (!parseResult.success) return reply.status(400).send({ error: 'Invalid identifier' });
    const documentRecord = await prisma.document.findUnique({ where: { id: parseResult.data.id } });
    if (!documentRecord) return reply.status(404).send({ error: 'Document not found' });
    let text = documentRecord.fullText;
    if (text === null) {
      // Document indexed before full_text existed: extract it again from the original.
      const extraction = await extractText(documentRecord.storedPath, documentRecord.filename);
      text = extraction.text;
      await prisma.document.update({ where: { id: documentRecord.id }, data: { fullText: text } });
    }
    return { filename: documentRecord.filename, note: documentRecord.note, text };
  });

  app.delete('/api/documents/:id', async (request, reply) => {
    const parseResult = identifierParamsSchema.safeParse(request.params);
    if (!parseResult.success) return reply.status(400).send({ error: 'Invalid identifier' });
    const documentRecord = await prisma.document.findUnique({ where: { id: parseResult.data.id } });
    if (!documentRecord) return reply.status(404).send({ error: 'Document not found' });
    await prisma.document.delete({ where: { id: documentRecord.id } });
    await rm(documentRecord.storedPath, { force: true });
    return { ok: true };
  });
}
