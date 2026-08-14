import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
});

describe('GET /api/search', () => {
  it('refuses a request without the q parameter', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/search' });
    expect(response.statusCode).toBe(400);
  });

  it('answers with a result list for a valid request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/search?q=notfoundximplausible' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ results: [] });
  });
});

describe('GET /api/stats', () => {
  it('returns the database counters', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ documents: number; chunks: number; bytes: number }>();
    expect(body.documents).toBeTypeOf('number');
    expect(body.chunks).toBeTypeOf('number');
    expect(body.bytes).toBeTypeOf('number');
  });
});

describe('GET /api/documents', () => {
  it('returns the document list', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/documents' });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json<{ documents: unknown[] }>().documents)).toBe(true);
  });
});

describe('POST /api/upload with a note', () => {
  it('indexes the file, stores the note and makes it searchable', async () => {
    const boundary = '----cara7testboundary';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="note"',
      '',
      'Test note about the zorglub',
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="test-note-cara7.txt"',
      'Content-Type: text/plain',
      '',
      'Content of the file used by the note test.',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const uploadResponse = await app.inject({
      method: 'POST',
      url: '/api/upload',
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(uploadResponse.statusCode).toBe(200);
    const { results } = uploadResponse.json<{ results: Array<{ ok: boolean; id?: number; chunks?: number }> }>();
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.chunks).toBe(2);
    const documentId = results[0]?.id;

    const listResponse = await app.inject({ method: 'GET', url: '/api/documents' });
    const { documents } = listResponse.json<{ documents: Array<{ id: number; note: string | null }> }>();
    expect(documents.find((d) => d.id === documentId)?.note).toBe('Test note about the zorglub');

    const searchResponse = await app.inject({ method: 'GET', url: '/api/search?q=zorglub' });
    const { results: found } = searchResponse.json<{ results: Array<{ documentId: number }> }>();
    expect(found.some((r) => r.documentId === documentId)).toBe(true);

    const textResponse = await app.inject({ method: 'GET', url: `/api/documents/${documentId}/text` });
    expect(textResponse.statusCode).toBe(200);
    expect(textResponse.json<{ text: string }>().text).toBe('Content of the file used by the note test.');

    const deleteResponse = await app.inject({ method: 'DELETE', url: `/api/documents/${documentId}` });
    expect(deleteResponse.statusCode).toBe(200);
  });

  it('keeps the same id when a file of the same name is uploaded again', async () => {
    const boundary = '----cara7replaceboundary';
    const upload = async (body: string): Promise<{ id?: number; chars?: number }> => {
      const payload = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"; filename="test-replace-cara7.txt"',
        'Content-Type: text/plain',
        '',
        body,
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const response = await app.inject({
        method: 'POST',
        url: '/api/upload',
        payload,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      expect(response.statusCode).toBe(200);
      return response.json<{ results: Array<{ id?: number; chars?: number }> }>().results[0] ?? {};
    };

    const first = await upload('Version one of the replaceable document.');
    const second = await upload('Version two, longer, of the same replaceable document.');
    // The id is stable: callers keep their references across an update.
    expect(second.id).toBe(first.id);
    expect(second.chars).not.toBe(first.chars);

    const textResponse = await app.inject({ method: 'GET', url: `/api/documents/${first.id}/text` });
    expect(textResponse.json<{ text: string }>().text).toContain('Version two');

    await app.inject({ method: 'DELETE', url: `/api/documents/${first.id}` });
  });
});

describe('DELETE /api/documents/:id', () => {
  it('refuses a non-numeric identifier', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/documents/abc' });
    expect(response.statusCode).toBe(400);
  });

  it('answers 404 for a document that does not exist', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/documents/999999' });
    expect(response.statusCode).toBe(404);
  });
});
