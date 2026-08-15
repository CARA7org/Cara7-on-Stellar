import type { FastifyInstance } from 'fastify';
import { getBytes } from '../ipfs/store.js';
import { openConfidential, encryptionConfigured, type SealedSection } from '../ipfs/encryption.js';
import { environment } from '../config.js';
import { loadRegistry } from './registry.js';

export async function tokensRoutes(app: FastifyInstance): Promise<void> {
  // Index of the diagram's 4 token families (minted on-chain).
  app.get('/tokens', async () => {
    const registry = loadRegistry();
    if (!registry) return { minted: false, note: 'Run `pnpm mint` to mint the 61 NFTs' };
    return { minted: true, ...registry };
  });

  app.get('/tokens/:type', async (request, reply) => {
    const { type } = request.params as { type: string };
    const registry = loadRegistry();
    if (!registry) return reply.status(404).send({ error: 'Registry missing (run pnpm mint)' });
    const tokens = registry.tokens.filter((token) => token.tokenType === type);
    if (tokens.length === 0) return reply.status(404).send({ error: `Unknown type: ${type}` });
    return { contractId: registry.contracts[type as keyof typeof registry.contracts], tokens };
  });

  /**
   * Authorized clear view of sealed metadata (the demo's "data room" door):
   * returns the document with its confidential section decrypted in place.
   * Bearer METADATA_VIEWER_TOKEN required - the public IPFS gateway keeps
   * serving the sealed envelope untouched.
   */
  app.get('/metadata/:cid/clear', async (request, reply) => {
    const token = environment.METADATA_VIEWER_TOKEN;
    const header = request.headers.authorization ?? '';
    if (!token || header !== `Bearer ${token}`) {
      return reply.status(401).send({ error: 'Bearer METADATA_VIEWER_TOKEN required' });
    }
    if (!encryptionConfigured()) {
      return reply.status(409).send({ error: 'METADATA_ENCRYPTION_KEY not configured' });
    }
    const { cid } = request.params as { cid: string };
    const bytes = getBytes(cid);
    if (!bytes) return reply.status(404).send({ error: 'Unknown CID' });
    const document = JSON.parse(bytes.toString('utf8')) as Record<string, unknown> & {
      sealed?: SealedSection;
    };
    if (!document.sealed) return { document, sealed: false };
    const { sealed, ...publicPart } = document;
    return { document: { ...publicPart, confidential: openConfidential(sealed) }, sealed: true };
  });
}
