import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

/// The migration CLI honours `?schema=` in the URL, but the client's pg
/// adapter ignores it: the schema must be passed explicitly.
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const schema = new URL(databaseUrl).searchParams.get('schema') ?? undefined;
  const adapter = new PrismaPg(
    { connectionString: databaseUrl },
    schema ? { schema } : undefined,
  );
  return new PrismaClient({ adapter });
}
