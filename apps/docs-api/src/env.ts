import 'dotenv/config';
import { z } from 'zod';

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (see .env.example)'),
  PORT: z.coerce.number().int().positive().default(3333),
  HOST: z.string().default('127.0.0.1'),
  // When set, every /api route requires this token (mandatory in production).
  KB_TOKEN: z.string().min(16).optional(),
  // Comma-separated CORS origins (the Vercel domain, for instance).
  CORS_ORIGIN: z.string().optional(),
});

export const environment = environmentSchema.parse(process.env);
