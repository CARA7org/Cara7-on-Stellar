import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { environment } from './config.js';

// The migration CLI honours `?schema=` in the URL, but the client's pg
// adapter ignores it: the schema must be passed explicitly.
const schema = new URL(environment.DATABASE_URL).searchParams.get('schema') ?? undefined;
const adapter = new PrismaPg(
  { connectionString: environment.DATABASE_URL },
  schema ? { schema } : undefined,
);

export const prisma = new PrismaClient({ adapter });

/// Recursively convert BigInt to string, so that values coming from
/// scValToNative (i128/u64 arrive as BigInt) fit the Json columns of Prisma.
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  }
  return value;
}
