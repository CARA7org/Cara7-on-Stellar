import 'dotenv/config';
import { z } from 'zod';

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL est requis (voir .env.example)'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('127.0.0.1'),
  SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
  REFLECTOR_CONTRACT_ID: z
    .string()
    .default('CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63'),
  CRON_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),
  START_LEDGER: z.coerce.number().int().positive().optional(),
  // First-boot seed: the v4 ABS-notes generation on testnet (abs-deal +
  // CARA7A/B/C note tokens + paying agent), base asset = the demo EURC.
  SEED_DEAL_NAME: z.string().default('Bavarian Sky French Auto Leases 5'),
  SEED_DEAL_CONTRACT_ID: z
    .string()
    .default('CB3S3NWG7IUKUBAWAAJPFKVMCIMTRJ73GHZX6YZASRMZPVUGYFLCATJ4'),
  SEED_PAYING_AGENT_ID: z
    .string()
    .default('CAXBYHZVHXOP3HQCMXPPVZMDUYEO27CTQQQDMWVNMMGSRCBSJHGIARZW'),
  SEED_NOTE_A_ID: z
    .string()
    .default('CBHFKNK7UK6YBVXZUWPOMY6LK44FZJSKWHPF4HJBUBV64KC455IJDROK'),
  SEED_NOTE_B_ID: z
    .string()
    .default('CDRPAMGBJ6BSRQZE5M56DYCFZW7ODPFVCYLT4AA2OQGIUIDHPCTRBU3O'),
  SEED_NOTE_C_ID: z
    .string()
    .default('CB3IK7HZQMZZG4GIYOEUPRUEIDUP54MIHXIBYLLAM4QUKHB7H7MYIOQJ'),
  SEED_BASE_ASSET_ID: z
    .string()
    .default('CBEO2RDQKBM7S3TYOYKBWAJEC6WMYPCW6JJWX47UCLFMUJI2EUZPJOXW'),
  SEED_ASSET_SYMBOL: z.string().default('EURC'),
});

export const environment = environmentSchema.parse(process.env);
