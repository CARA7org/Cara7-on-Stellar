import 'dotenv/config';
import { z } from 'zod';

/// A PEM key in one env line uses "\n" for the line breaks.
export const pemSchema = z
  .string()
  .min(1)
  .transform((value) => value.replace(/\\n/g, '\n'));

/// The variables of the custody server. The checker has its own set in
/// src/checker/config.ts. The server must not need the checker variables.
export const serverEnvironmentSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8091),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (see .env.example)'),
  CORS_ORIGIN: z.string().url().default('http://localhost:3001'),
  WEBAUTHN_RP_ID: z.string().min(1).default('localhost'),
  WEBAUTHN_RP_NAME: z.string().min(1).default('CARA7'),
  WEBAUTHN_ORIGIN: z.string().url().default('http://localhost:3001'),
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  HORIZON_URL: z.string().url().default('https://horizon-testnet.stellar.org'),
  FRIENDBOT_URL: z.string().url().default('https://friendbot.stellar.org'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  // The initiator service account: it starts the signature requests.
  DFNS_API_URL: z.string().url().default('https://api.dfns.io'),
  DFNS_ORG_ID: z.string().min(1, 'DFNS_ORG_ID is required (see .env.example)'),
  DFNS_AUTH_TOKEN: z.string().min(1, 'DFNS_AUTH_TOKEN is required (see .env.example)'),
  DFNS_CRED_ID: z.string().min(1, 'DFNS_CRED_ID is required (see .env.example)'),
  DFNS_PRIVATE_KEY: pemSchema,
});

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

export function parseServerEnvironment(source: NodeJS.ProcessEnv): ServerEnvironment {
  return parseEnvironment(serverEnvironmentSchema, source, 'custody-api');
}

export function parseEnvironment<T extends z.ZodType>(
  schema: T,
  source: NodeJS.ProcessEnv,
  name: string,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`The ${name} configuration is not valid. ${issues.join('; ')}`);
  }
  return result.data;
}
