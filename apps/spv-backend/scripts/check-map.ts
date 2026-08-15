import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { projectRoot, mapDirectory } from '../src/paths.js';

/**
 * Map integrity check (part of `pnpm check`). The map renders the original
 * draw.io "Data Spec Book" page verbatim and overlays clickable code links
 * (map/index.html, <script id="map-links">). Every link must point at a
 * path that exists in the repo AND at a cell id that exists in the schema
 * XML; every implemented agent must be linked. The map must never lie.
 */
const monorepoRoot = path.resolve(projectRoot, '..', '..');
const html = readFileSync(path.join(mapDirectory, 'index.html'), 'utf8');
const schemaXml = readFileSync(path.join(mapDirectory, 'data-spec-book.diagram.xml'), 'utf8');

const match = html.match(/<script type="application\/json" id="map-links">([\s\S]*?)<\/script>/);
if (!match?.[1]) {
  console.error('map-check: no <script id="map-links"> block in map/index.html');
  process.exit(1);
}
const data = JSON.parse(match[1]) as { links: Record<string, string> };

let failures = 0;
for (const [cellId, repoPath] of Object.entries(data.links)) {
  const problems: string[] = [];
  if (!schemaXml.includes(`id="${cellId}"`)) problems.push('cell id missing from schema XML');
  if (!existsSync(path.join(monorepoRoot, repoPath))) problems.push('path missing on disk');
  if (problems.length > 0) {
    console.error(`FAIL ${cellId} -> ${repoPath} (${problems.join('; ')})`);
    failures += 1;
  } else {
    console.log(`  ok ${cellId} -> ${repoPath}`);
  }
}

// Reverse direction: every implemented agent (and the MCP server) must be
// reachable from the schema.
const linkedPaths = new Set(Object.values(data.links));
for (const agent of [
  'accounting', 'audit', 'anti-fraud', 'data-custody', 'interest-determination',
  'calculation', 'paying', 'verifier', 'compliance', 'rse', 'mcp-access',
]) {
  const repoPath = `apps/spv-backend/src/agents/${agent}`;
  if (!existsSync(path.join(projectRoot, 'src', 'agents', agent))) {
    console.error(`FAIL agents/${agent}: folder missing on disk`);
    failures += 1;
  } else if (!linkedPaths.has(repoPath)) {
    console.error(`FAIL agents/${agent}: implemented but not linked on the map`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`\nmap-check: ${failures} problem(s)`);
  process.exit(1);
}
console.log(`\nmap-check: all ${Object.keys(data.links).length} links consistent with schema + repo`);
