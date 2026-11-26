import 'dotenv/config';
import { z } from 'zod';
import { CLI_IDENTITY_PATTERN, SECRET_SEED_PATTERN } from './custody/cli-signer.js';

// The name of an identity in the local Stellar CLI keystore. Never a key.
const cliIdentity = z
  .string()
  .regex(CLI_IDENTITY_PATTERN, 'the name of a Stellar CLI identity expected (letters, digits, _ or -)')
  .refine((value) => !SECRET_SEED_PATTERN.test(value), 'this is a secret key. Give the identity name.')
  .optional();

export const environmentSchema = z.object({
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
  // Horizon serves the classic operations (ChangeTrust) and the account reads.
  HORIZON_URL: z.string().url().default('https://horizon-testnet.stellar.org'),
  // The classic asset of the servicer trustline. By default the backend
  // reads it from the deal asset contract (its name() is "CODE:ISSUER").
  // Set both values only to override that asset.
  EURC_CODE: z.string().min(1).max(12).optional(),
  EURC_ISSUER: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'a Stellar account address (G...) expected')
    .optional(),
  // The signer of the operator roles. `dfns` is the production custody.
  // `stellar-cli` is a development signer for the testnet demo: the local
  // Stellar CLI keystore signs, so the backend still holds no secret.
  OPERATOR_SIGNER: z.enum(['dfns', 'stellar-cli']).default('dfns'),
  // With OPERATOR_SIGNER=stellar-cli: the identity name of each role in the
  // Stellar CLI keystore (`stellar keys ls`). Names only, never keys.
  CLI_ADMIN_IDENTITY: cliIdentity,
  CLI_SERVICER_IDENTITY: cliIdentity,
  CLI_REPORTER_IDENTITY: cliIdentity,
  CLI_CRANK_IDENTITY: cliIdentity,
  // Operator custody through Dfns. The backend holds no Stellar key.
  // All settings are optional: without them the server starts read-only,
  // and each signed operation fails with a message that names the missing
  // setting. See .env.example.
  DFNS_API_URL: z.string().url().default('https://api.dfns.io'),
  DFNS_ORG_ID: z.string().optional(),
  DFNS_AUTH_TOKEN: z.string().optional(),
  DFNS_CRED_ID: z.string().optional(),
  // The service account credential key (PEM). A literal "\n" becomes a line break.
  DFNS_PRIVATE_KEY: z
    .string()
    .optional()
    .transform((value) => value?.replace(/\\n/g, '\n')),
  DFNS_ADMIN_WALLET_ID: z.string().optional(),
  DFNS_SERVICER_WALLET_ID: z.string().optional(),
  DFNS_REPORTER_WALLET_ID: z.string().optional(),
  DFNS_CRANK_WALLET_ID: z.string().optional(),
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

export type Environment = z.infer<typeof environmentSchema>;

export const environment: Environment = environmentSchema.parse(process.env);
