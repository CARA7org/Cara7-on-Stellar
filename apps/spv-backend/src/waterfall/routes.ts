import type { FastifyInstance } from 'fastify';
import { xdr } from '@stellar/stellar-sdk';
import { environment } from '../config.js';
import { periodCollections } from './collections.js';
import { invokeSigned, readContract, addressArg, i128Arg, servicerPublicKey } from './soroban.js';

const EURC_DECIMALS = 7;
const RATE_SCALE = 100_000; // 0.001% units, shared with the contracts
const FACTOR_SCALE = 10_000_000; // 100% in note-factor units
const DAY_COUNT_BASE = 360;

function u32Arg(value: number): xdr.ScVal {
  return xdr.ScVal.scvU32(value);
}

/** distribute() returns i128 amounts as BigInt - stringify them for JSON. */
function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
  );
}

function toEurc(baseUnits: bigint): number {
  return Number(baseUnits) / 10 ** EURC_DECIMALS;
}

interface AllocView {
  class: number;
  interestEurc: number;
  principalEurc: number;
  perNotePrincipalEurc: number;
  cursor: number;
  holderCount: number;
  pushed: boolean;
}

interface WaterfallStateView {
  /** Deal lifecycle: FUNDING | AMORTIZING | ENFORCED | MATURED | ABORTED. */
  phase: string;
  euriborFixing: { ratePct: number; ageSeconds: number } | null;
  reserveEurc: number;
  /** Rounding-dust carry re-entering next period's ADA, in EURC. */
  carryEurc: number;
  noteFactorsPct: number[];
  outstandingEurc: number[];
  shortfallsEurc: number[];
  /** Cumulative principal redeemed per class (initial - outstanding). */
  principalRepaidEurc: number[];
  /** Paying agent CONTRACT: receives interest AND principal, pushes to holders. */
  payingAgent: {
    contractId: string;
    balanceEurc: number;
    lastPeriod: number | null;
    allocs: AllocView[];
  } | null;
  nextPeriod: number;
  nextInterestEurc: number[];
}

interface DealConfigView {
  days_in_period: number;
  asset: string;
  note_denomination: bigint;
  classes: { rate: unknown; total_notes: bigint }[];
}

/** v4 on-chain state + the interest each class accrues next period. */
export async function waterfallState(): Promise<WaterfallStateView> {
  const [phase, reserve, carry, factors, outstanding, shortfalls, nextPeriod, config, wiring, fixing] =
    await Promise.all([
      readContract(environment.DEAL_CONTRACT_ID, 'get_state') as Promise<string>,
      readContract(environment.DEAL_CONTRACT_ID, 'get_reserve') as Promise<bigint>,
      readContract(environment.DEAL_CONTRACT_ID, 'get_carry') as Promise<bigint>,
      readContract(environment.DEAL_CONTRACT_ID, 'get_note_factors') as Promise<bigint[]>,
      readContract(environment.DEAL_CONTRACT_ID, 'get_outstanding') as Promise<bigint[]>,
      readContract(environment.DEAL_CONTRACT_ID, 'get_shortfalls') as Promise<bigint[]>,
      readContract(environment.DEAL_CONTRACT_ID, 'get_next_period') as Promise<number>,
      readContract(environment.DEAL_CONTRACT_ID, 'get_config') as Promise<DealConfigView>,
      readContract(environment.DEAL_CONTRACT_ID, 'get_wiring') as Promise<{
        note_tokens: string[];
        paying_agent: string;
      } | null>,
      readContract(environment.RATE_ORACLE_CONTRACT_ID, 'lastprice') as Promise<{
        price: bigint;
        timestamp: bigint;
      } | null>,
    ]);

  const nextInterestEurc = outstanding.map((nominal, index) => {
    const terms = config.classes[index];
    if (!terms) return 0;
    // scValToNative renders Soroban tuple-enums as a flat [tag, value] array.
    const rate = terms.rate as [string, bigint | number] | { tag: string; values: unknown[] };
    const [variant, raw] = Array.isArray(rate) ? [rate[0], rate[1]] : [rate.tag, rate.values?.[0]];
    const paramUnits = typeof raw === 'bigint' ? raw : BigInt(Number(raw ?? 0));
    let rateUnits = 0n;
    if (variant === 'Fixed') {
      rateUnits = paramUnits;
    } else if (fixing) {
      const allIn = paramUnits + fixing.price; // spread + EURIBOR, floor 0 (Class A)
      rateUnits = allIn > 0n ? allIn : 0n;
    }
    const interest =
      (nominal * rateUnits * BigInt(config.days_in_period)) /
      BigInt(DAY_COUNT_BASE) /
      BigInt(RATE_SCALE);
    return toEurc(interest);
  });

  // Paying agent contract: undistributed balance + per-class push state of
  // the last executed period.
  const lastPeriod = nextPeriod > 1 ? nextPeriod - 1 : null;
  const payingAgent = await (async () => {
    if (!wiring) return null;
    const agentId = wiring.paying_agent;
    let balanceEurc = Number.NaN;
    try {
      balanceEurc = toEurc(
        (await readContract(config.asset, 'balance', [addressArg(agentId)])) as bigint,
      );
    } catch {
      // balance stays NaN - the rest of the view is still useful
    }
    const allocs: AllocView[] = [];
    if (lastPeriod !== null) {
      for (let classIndex = 0; classIndex < config.classes.length; classIndex++) {
        try {
          const alloc = (await readContract(agentId, 'get_alloc', [
            u32Arg(lastPeriod),
            u32Arg(classIndex),
          ])) as {
            interest_pot: bigint;
            principal: bigint;
            per_note_principal: bigint;
            cursor: number;
            holder_count: number;
            done: boolean;
          } | null;
          if (!alloc) continue;
          allocs.push({
            class: classIndex,
            interestEurc: toEurc(alloc.interest_pot),
            principalEurc: toEurc(alloc.principal),
            perNotePrincipalEurc: toEurc(alloc.per_note_principal),
            cursor: Number(alloc.cursor),
            holderCount: Number(alloc.holder_count),
            pushed: Boolean(alloc.done),
          });
        } catch {
          // alloc absent (period not funded for this class)
        }
      }
    }
    return { contractId: agentId, balanceEurc, lastPeriod, allocs };
  })();

  return {
    phase: String(phase).toUpperCase(),
    euriborFixing: fixing
      ? {
          ratePct: Number(fixing.price) / 1000,
          ageSeconds: Math.max(0, Math.floor(Date.now() / 1000) - Number(fixing.timestamp)),
        }
      : null,
    reserveEurc: toEurc(reserve),
    carryEurc: toEurc(carry),
    noteFactorsPct: factors.map((factor) => Number(factor) / (FACTOR_SCALE / 100)),
    outstandingEurc: outstanding.map(toEurc),
    shortfallsEurc: shortfalls.map(toEurc),
    principalRepaidEurc: outstanding.map((nominal, index) => {
      const terms = config.classes[index];
      const initial = terms ? terms.total_notes * config.note_denomination : nominal;
      return toEurc(initial - nominal);
    }),
    payingAgent,
    nextPeriod: Number(nextPeriod),
    nextInterestEurc,
  };
}

/** Crank the paying agent until every class of `period` is fully pushed. */
async function pushAllBatches(
  period: number,
  classCount: number,
): Promise<{ hash: string; class: number; cursor: number }[]> {
  const pushes: { hash: string; class: number; cursor: number }[] = [];
  for (let classIndex = 0; classIndex < classCount; classIndex++) {
    for (let batch = 0; batch < 50; batch++) {
      const alloc = (await readContract(environment.PAYING_AGENT_CONTRACT_ID, 'get_alloc', [
        u32Arg(period),
        u32Arg(classIndex),
      ])) as { done: boolean } | null;
      if (!alloc || alloc.done) break;
      const outcome = (await invokeSigned(environment.PAYING_AGENT_CONTRACT_ID, 'push_batch', [
        u32Arg(period),
        u32Arg(classIndex),
        u32Arg(10),
      ])) as { hash: string; result: unknown };
      pushes.push({ hash: outcome.hash, class: classIndex, cursor: Number(outcome.result ?? 0) });
    }
  }
  return pushes;
}

/**
 * Bridge to the abs-deal contract (v4): the period collection computed from
 * the pool is cascaded on-chain through distribute() - fees, oracle-indexed
 * Class A interest (floor 0%), fixed B/C interest, full-cycle reserve,
 * sequential principal, residual to the seller. Interest AND principal go
 * to the paying agent contract, which pushes EURC to every noteholder.
 */
export async function waterfallRoutes(app: FastifyInstance): Promise<void> {
  // Period preview: collections + the v4 on-chain state they will meet.
  app.get('/waterfall/period-preview', async () => {
    const collections = periodCollections();
    let state: WaterfallStateView | null = null;
    try {
      state = await waterfallState();
    } catch {
      // RPC unavailable: the pool-side preview still renders
    }
    return {
      dealContract: environment.DEAL_CONTRACT_ID,
      payingAgentContract: environment.PAYING_AGENT_CONTRACT_ID,
      rateOracle: environment.RATE_ORACLE_CONTRACT_ID,
      ...collections,
      onchain: state,
      note: 'collected = installments of PERF loans with no arrears; missed = absorbed by the cascade (reserve first)',
    };
  });

  // The closing DvP: proceeds to the Seller, reserve funded from the
  // sub-loan, notes issued at par. Admin-signed (demo: same identity).
  app.post('/waterfall/close-deal', async (request, reply) => {
    try {
      const state = (await readContract(environment.DEAL_CONTRACT_ID, 'get_state')) as string;
      if (String(state).toUpperCase() !== 'FUNDING') {
        return reply.status(409).send({ error: `Deal is ${state}, not FUNDING` });
      }
      const outcome = (await invokeSigned(environment.DEAL_CONTRACT_ID, 'close', [])) as {
        hash: string;
      };
      const onchain = await waterfallState().catch(() => null);
      return {
        closed: true,
        onchain,
        transactionHash: outcome.hash,
        explorer: `https://stellar.expert/explorer/testnet/tx/${outcome.hash}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(502).send({ error: message });
    }
  });

  // Runs the period: distribute(period, collected) signed by the servicer,
  // then cranks the paying agent's push batches until every holder is paid.
  app.post('/waterfall/run-period', async (request, reply) => {
    const collections = periodCollections();
    if (collections.collected <= 0) {
      return reply.status(409).send({ error: 'No collections to distribute' });
    }
    const amountBase = BigInt(Math.round(collections.collected * 10 ** EURC_DECIMALS));
    try {
      const period = Number(
        (await readContract(environment.DEAL_CONTRACT_ID, 'get_next_period')) as number,
      );
      const classCount = (
        (await readContract(environment.DEAL_CONTRACT_ID, 'get_note_factors')) as bigint[]
      ).length;
      const outcome = (await invokeSigned(environment.DEAL_CONTRACT_ID, 'distribute', [
        u32Arg(period),
        i128Arg(amountBase),
      ])) as { hash: string; result: unknown };
      const pushes = await pushAllBatches(period, classCount);
      const state = await waterfallState().catch(() => null);
      return {
        period,
        distributed: collections.collected,
        missed: collections.missed,
        perClass: jsonSafe(outcome.result),
        pushes,
        onchain: state,
        transactionHash: outcome.hash,
        explorer: `https://stellar.expert/explorer/testnet/tx/${outcome.hash}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(502).send({ error: message });
    }
  });

  // Resume/retry the holder pushes of a period (idempotent: the contract's
  // cursor + per-holder markers make double-pay impossible).
  app.post('/waterfall/push-distribution', async (request, reply) => {
    const body = (request.body ?? {}) as { period?: number };
    try {
      const nextPeriod = Number(
        (await readContract(environment.DEAL_CONTRACT_ID, 'get_next_period')) as number,
      );
      const period = body.period ?? nextPeriod - 1;
      if (period < 1) return reply.status(409).send({ error: 'No period executed yet' });
      const classCount = (
        (await readContract(environment.DEAL_CONTRACT_ID, 'get_note_factors')) as bigint[]
      ).length;
      const pushes = await pushAllBatches(period, classCount);
      return { period, pushes, complete: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(502).send({ error: message });
    }
  });

  // Noteholder registry per class, proxied from the tranching-api indexer.
  app.get('/waterfall/holders', async (_request, reply) => {
    try {
      const wiring = (await readContract(environment.DEAL_CONTRACT_ID, 'get_wiring')) as {
        note_tokens: string[];
      } | null;
      if (!wiring) return reply.status(409).send({ error: 'Deal not wired' });
      const classes = await Promise.all(
        wiring.note_tokens.map(async (noteId, classIndex) => {
          const response = await fetch(
            `${environment.TRANCHING_API_URL}/notes/${noteId}/holders`,
          );
          const holders = response.ok ? await response.json() : [];
          return { class: classIndex, noteContract: noteId, holders };
        }),
      );
      return { classes };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(502).send({ error: message });
    }
  });
}
