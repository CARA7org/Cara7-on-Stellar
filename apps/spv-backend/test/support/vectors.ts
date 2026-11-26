import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { repositoryRoot } from '../../src/paths.js';

/**
 * The test vectors of the abs-deal contract (contracts/abs-deal/vectors).
 * The Rust tests write them: each file is one deal and its payment dates,
 * with the figures that the contract gave. The TypeScript tests must find
 * the same figures.
 */
const VECTORS_DIR = path.join(repositoryRoot, 'contracts', 'abs-deal', 'vectors');

const amount = z.string().regex(/^-?\d+$/).transform((value) => BigInt(value));

const ledgersSchema = z.object({
  state: z.enum(['Amortizing', 'Enforced', 'Matured']),
  reserve: amount,
  carry: amount,
  owed: amount,
  balance: amount,
  per_note: z.array(amount),
  shortfall: z.array(amount),
  triggers: z.array(z.boolean()),
});

const itemSchema = z.union([
  z.tuple([z.enum(['Fee', 'Interest', 'Principal']), z.number().int()]),
  z.tuple([z.enum(['ReserveRefill', 'Residual'])]),
]);

const periodSchema = z.object({
  period: z.number().int(),
  collections: amount,
  fixing: amount.nullable(),
  opening: ledgersSchema,
  parked: z.array(z.string()),
  returned: z.array(amount),
  enforced: z.boolean(),
  lines: z.array(z.tuple([z.string(), itemSchema, amount, amount, amount])),
  settled: z.object({
    collections: amount,
    reserve_in: amount,
    carry_in: amount,
    drawn: amount,
    paid_out: amount,
    reserve: amount,
    carry: amount,
    owed: amount,
    balance: amount,
    surplus: amount,
  }),
  breached: z.array(z.string()),
  closing: ledgersSchema,
  events: z.array(z.object({ topics: z.array(z.unknown()), data: z.unknown(), xdr: z.string() })),
});

const vectorSchema = z.object({
  name: z.string(),
  about: z.string(),
  contracts: z.object({ deal: z.string(), paying_agent: z.string(), asset: z.string(), oracle: z.string() }),
  config_xdr: z.string(),
  periods: z.array(periodSchema),
});

export type Vector = z.infer<typeof vectorSchema>;
export type VectorPeriod = z.infer<typeof periodSchema>;
export type VectorLedgers = z.infer<typeof ledgersSchema>;

/** Every vector of the contract tests, in file name order. */
export function loadVectors(): Vector[] {
  return readdirSync(VECTORS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => vectorSchema.parse(JSON.parse(readFileSync(path.join(VECTORS_DIR, name), 'utf8'))));
}

/** One vector by its name, for example "deal-p". */
export function loadVector(name: string): Vector {
  const vector = loadVectors().find((candidate) => candidate.name === name);
  if (!vector) throw new Error(`No vector has the name ${name}.`);
  return vector;
}
