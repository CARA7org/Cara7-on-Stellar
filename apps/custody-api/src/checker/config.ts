import { z } from 'zod';
import { parseEnvironment, pemSchema } from '../config.js';

/// The variables of the checker. It shares the org id, the API URL and the
/// network with the server. It does not need the initiator credentials.
export const checkerEnvironmentSchema = z.object({
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  DFNS_API_URL: z.string().url().default('https://api.dfns.io'),
  DFNS_ORG_ID: z.string().min(1, 'DFNS_ORG_ID is required (see .env.example)'),
  CHECKER_DFNS_AUTH_TOKEN: z.string().min(1, 'CHECKER_DFNS_AUTH_TOKEN is required (see .env.example)'),
  CHECKER_DFNS_CRED_ID: z.string().min(1, 'CHECKER_DFNS_CRED_ID is required (see .env.example)'),
  CHECKER_DFNS_PRIVATE_KEY: pemSchema,
  CHECKER_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3600)
    .default(5)
    .refine((seconds) => seconds < 60 || seconds % 60 === 0, 'must be below 60 or a multiple of 60'),
});

export type CheckerEnvironment = z.infer<typeof checkerEnvironmentSchema>;

export function parseCheckerEnvironment(source: NodeJS.ProcessEnv): CheckerEnvironment {
  return parseEnvironment(checkerEnvironmentSchema, source, 'checker');
}

/// node-cron expression for an interval in seconds.
export function cronExpression(seconds: number): string {
  return seconds % 60 === 0 ? `0 */${seconds / 60} * * * *` : `*/${seconds} * * * * *`;
}
