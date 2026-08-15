import type { FastifyInstance } from 'fastify';
import { repositoryRoot } from '../paths.js';

export async function mapRoutes(app: FastifyInstance): Promise<void> {
  // The map opens each diagram box either on GitHub or in the local editor.
  // A vscode:// link needs the absolute path of the checkout, which the
  // browser cannot know: the server is the only side that does.
  app.get('/map/local-root', async () => ({ root: repositoryRoot }));
}
