import 'dotenv/config';
import { z } from 'zod';

const environmentSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8090),
  HOST: z.string().default('127.0.0.1'),
  SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
  TRANCHING_API_URL: z.string().url().default('http://localhost:8080'),
  // abs-deal contract (v4): funding escrow, closing DvP, waterfall - all
  // noteholder money (interest AND principal) leaves through the paying
  // agent contract; nothing is ever paid into the note tokens.
  DEAL_CONTRACT_ID: z
    .string()
    .default('CB3S3NWG7IUKUBAWAAJPFKVMCIMTRJ73GHZX6YZASRMZPVUGYFLCATJ4'),
  PAYING_AGENT_CONTRACT_ID: z
    .string()
    .default('CAXBYHZVHXOP3HQCMXPPVZMDUYEO27CTQQQDMWVNMMGSRCBSJHGIARZW'),
  // EURIBOR 1M RateOracle (Chainlink-relayed, SEP-40-style interface).
  RATE_ORACLE_CONTRACT_ID: z
    .string()
    .default('CAAOMPQADAW34FU4VUXDUHS6RDF6SVGCTK4S2T2YONIKNQA22IBYA72X'),
  // Servicer key: only required to mint and to run a distribution.
  SERVICER_SECRET: z.string().startsWith('S').optional(),
  // Optional IPFS pinning: our CIDs (raw, v1) match cidVersion=1.
  PINATA_JWT: z.string().optional(),
  // Deal-level AES-256-GCM key sealing the `confidential` section of NFT
  // metadata (32 bytes hex - `openssl rand -hex 32`). Destroying it is the
  // GDPR crypto-shredding switch.
  METADATA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, '32 hex bytes expected (openssl rand -hex 32)')
    .optional(),
  // Bearer token gating the clear-view endpoint of sealed metadata.
  METADATA_VIEWER_TOKEN: z.string().min(16).optional(),
});

export const environment = environmentSchema.parse(process.env);
