import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const repositoryRoot = path.resolve(projectRoot, '..', '..');
export const mapDirectory = path.join(projectRoot, 'map');
export const ipfsStoreDirectory = path.join(projectRoot, 'src', 'ipfs', 'store');
export const reportsDirectory = path.join(projectRoot, 'src', 'reporting', 'reports');
