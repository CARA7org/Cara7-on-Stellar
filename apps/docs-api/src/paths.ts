import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Overridable in production: the Railway volume is mounted on /app/data while
// the app itself lives in /app/apps/docs-api (DATA_DIR=/app/data on the service).
const dataDirectory = process.env['DATA_DIR'] ?? path.join(projectRoot, 'data');

export const filesDirectory = path.join(dataDirectory, 'files');
export const publicDirectory = path.join(projectRoot, '..', 'docs-web', 'public');
