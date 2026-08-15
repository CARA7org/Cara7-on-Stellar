import { readdirSync, existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadPool, poolAggregates, VIN_PATTERN } from '../../asset-pool/pool.js';
import { loadRegistry } from '../../tokens/registry.js';
import { getBytes, listCids } from '../../ipfs/store.js';
import { periodCollections } from '../../waterfall/collections.js';
import { reportsDirectory } from '../../paths.js';

/**
 * The diagram's "AI Agents MCP Access" box: one stdio MCP server exposing the
 * deal's data as tools. Local files (pool.json, registry.json, IPFS store)
 * are read directly; tranche/distribution state comes from tranching-api.
 *
 * IMPORTANT: stdout carries the MCP protocol - nothing else may write to it,
 * which is why this file avoids config.ts (dotenv banners) and console.log.
 */
const TRANCHING_API_URL = process.env.TRANCHING_API_URL ?? 'http://localhost:8080';
const SPV_API_URL = process.env.SPV_API_URL ?? 'http://localhost:8090';
const DEAL_CONTRACT_ID =
  process.env.DEAL_CONTRACT_ID ??
  'CB3S3NWG7IUKUBAWAAJPFKVMCIMTRJ73GHZX6YZASRMZPVUGYFLCATJ4';
const PAYING_AGENT_CONTRACT_ID =
  process.env.PAYING_AGENT_CONTRACT_ID ??
  'CAXBYHZVHXOP3HQCMXPPVZMDUYEO27CTQQQDMWVNMMGSRCBSJHGIARZW';

const server = new McpServer({ name: 'deal', version: '1.0.0' });

function asText(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

server.registerTool(
  'get_pool',
  {
    description:
      'The full automobile asset pool (20 EV loans): per-vehicle VIN, loan, obligor and battery data, plus pool-level aggregates (WAM, WAR, performing %, monthly collections).',
  },
  async () => {
    const pool = loadPool();
    return asText({ ...pool, aggregates: poolAggregates(pool) });
  },
);

server.registerTool(
  'get_vehicle',
  {
    description: 'One pool entry by VIN: vehicle, battery, loan and obligor blocks.',
    inputSchema: { vin: z.string().regex(VIN_PATTERN, '17-char VIN, letters I/O/Q excluded') },
  },
  async ({ vin }) => {
    const entry = loadPool().vehicles.find((vehicle) => vehicle.vin === vin);
    if (!entry) return asText({ error: `VIN ${vin} not in pool` });
    return asText(entry);
  },
);

server.registerTool(
  'get_nft_registry',
  {
    description:
      'Minted NFT registry: the 4 asset-token contracts (auto/battery/obligor/pool) and every token with its tokenId, VIN, IPFS CID and mint transaction.',
  },
  async () => {
    const registry = loadRegistry();
    return asText(registry ?? { error: 'registry.json not found - tokens not minted yet' });
  },
);

server.registerTool(
  'get_ipfs',
  {
    description:
      'Read a metadata object from the content-addressed IPFS store by CID (accepts "bafkrei..." or "ipfs://bafkrei..."). Omit cid to list all stored CIDs.',
    inputSchema: { cid: z.string().optional() },
  },
  async ({ cid }) => {
    if (!cid) return asText({ cids: listCids() });
    const bytes = getBytes(cid.replace(/^ipfs:\/\//, ''));
    if (!bytes) return asText({ error: `CID ${cid} not in store` });
    return asText(JSON.parse(bytes.toString('utf8')));
  },
);

server.registerTool(
  'get_tranches',
  {
    description:
      'Live note registry from tranching-api: Class A/B/C note-token contracts, coupon bps, original face, outstanding nominal, note factors, cumulative interest/principal paid. There is no NAV and no share price - notes amortize.',
  },
  async () => asText(await fetchJson(`${TRANCHING_API_URL}/api/tranches`)),
);

server.registerTool(
  'get_distributions',
  {
    description:
      'On-chain waterfall v4 distribution history, grouped by period: collections, ADA, reserve released + refunded (full cycle), rounding-dust carry, per-class interest/principal/shortfall, residual - EURC base units = 10^-7 - plus the 3-day period schedule.',
  },
  async () => asText(await fetchJson(`${TRANCHING_API_URL}/api/deals/1/distributions`)),
);

server.registerTool(
  'get_note_events',
  {
    description:
      'Indexed on-chain events for one note-token contract by its contract id (issue, transfer, period_rolled, weight_frozen). Get contract ids from get_tranches.',
    inputSchema: { contractId: z.string().regex(/^C[A-Z2-7]{55}$/) },
  },
  async ({ contractId }) =>
    asText(await fetchJson(`${TRANCHING_API_URL}/notes/${contractId}/events`)),
);

server.registerTool(
  'get_noteholders',
  {
    description:
      'The noteholder registry per class: every holder with note units, share %, and cumulative interest/principal received from the paying agent. The per-class sums must reconcile with get_distributions - this is how the paying agent is audited.',
  },
  async () => asText(await fetchJson(`${SPV_API_URL}/waterfall/holders`)),
);

server.registerTool(
  'get_period_preview',
  {
    description:
      'What the servicer would collect for the CURRENT period from the pool: total due, collected (clean PERF loans) and missed installments (delinquent/restructured loans).',
  },
  async () => asText({ dealContract: DEAL_CONTRACT_ID, ...periodCollections() }),
);

server.registerTool(
  'get_waterfall_state',
  {
    description:
      'Live deal (v4) on-chain state via the spv-backend period preview: phase (FUNDING/AMORTIZING/ENFORCED/MATURED), EURIBOR fixing (rate + age), reserve, rounding-dust carry, note factors, outstanding nominals, shortfalls, cumulative principal repaid, the PAYING AGENT contract state (balance + per-class push status of the last period), next-period interest per class, and the period collections they will meet.',
  },
  async () => asText(await fetchJson(`${SPV_API_URL}/waterfall/period-preview`)),
);

server.registerTool(
  'get_reporting',
  {
    description:
      'Consolidated deal snapshot (the Reporting Dashboard): pool aggregates, NFT contracts, deal + paying agent contracts, live note tranches + distributions, and the list of agent reports already filed.',
  },
  async () => {
    const pool = loadPool();
    const registry = loadRegistry();
    let tranches: unknown = null;
    let distributions: unknown = null;
    try {
      tranches = ((await fetchJson(`${TRANCHING_API_URL}/api/tranches`)) as { tranches: unknown })
        .tranches;
      distributions = await fetchJson(`${TRANCHING_API_URL}/api/deals/1/distributions`);
    } catch {
      // tranching-api offline: degrade gracefully, agents still see local data
    }
    const reports = existsSync(reportsDirectory)
      ? readdirSync(reportsDirectory).filter((name) => name.endsWith('.md'))
      : [];
    return asText({
      pool: { poolId: pool.poolId, dealName: pool.dealName, aggregates: poolAggregates(pool) },
      nfts: registry
        ? { contracts: registry.contracts, tokenCount: registry.tokens.length }
        : { minted: false },
      dealContract: DEAL_CONTRACT_ID,
      payingAgentContract: PAYING_AGENT_CONTRACT_ID,
      tranches,
      distributions,
      agentReports: reports,
    });
  },
);

await server.connect(new StdioServerTransport());
