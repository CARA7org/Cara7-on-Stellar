import type { FastifyInstance } from 'fastify';
import { getBytes, listCids } from './store.js';

/// IPFS-style gateway: GET /ipfs/:cid serves the exact bytes of the CID.
export async function ipfsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ipfs', async () => ({ cids: listCids() }));

  app.get('/ipfs/:cid', async (request, reply) => {
    const { cid } = request.params as { cid: string };
    const bytes = getBytes(cid);
    if (!bytes) return reply.status(404).send({ error: 'CID not found in the local store' });
    reply.type('application/json');
    return reply.send(bytes);
  });
}
