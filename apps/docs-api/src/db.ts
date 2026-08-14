import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { environment } from './env.js';

const adapter = new PrismaPg({ connectionString: environment.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });
