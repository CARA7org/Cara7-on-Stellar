import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { environment } from '../config.js';
import { errorMessage } from '../custody/errors.js';
import { jsonSafe } from '../custody/operator.js';
import type { StellarNetwork } from '../custody/ports.js';
import { sendError, sendOperation } from '../custody/routes.js';
import type { OperatorServices } from '../custody/services.js';
import { numberToBaseUnits, toBaseUnits, toDisplayNumber } from '../deals/amounts.js';
import { decodeDealConfig } from '../deals/onchain.js';
import { periodCollections } from './collections.js';
import { accrue, classRate } from './engine.js';
import { engineView, readEngineState, readFixing, type EngineView } from './ledgers.js';
import {
  closeRequest,
  dealAssetOf,
  dealWiringOf,
  distributeRequest,
  explorerLinks,
  pushAllBatches,
  type DealAsset,
  type PushProgress,
} from './payment-date.js';
import { readContract, addressArg, u32Arg } from './soroban.js';

type ContractReader = StellarNetwork['read'];

const FACTOR_SCALE = 10_000_000; // 100% in note-factor units

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
  /**
   * The settlement asset. Each amount of this view is in units of this
   * asset: base units divided by 10 ^ decimals. The notes are denominated in
   * EUR and settle at par, so the "Eurc" names stay for older readers.
   */
  asset: DealAsset;
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

/**
 * The fields of `get_config` that the view needs. A deal of an earlier
 * contract code has no floor fields: its floating rate has a floor of 0 %,
 * and the interest of a rate below 0 % is 0 in each code.
 */
interface DealConfigView {
  days_in_period: number;
  asset: string;
  /** The oracle of the deal. */
  oracle?: string;
  note_denomination: bigint;
  classes: { rate: unknown; total_notes: bigint; floor?: bigint | null; index_floor?: bigint | null }[];
}

/**
 * v4 on-chain state + the interest each class accrues next period. The
 * amounts divide by the decimals of the deal asset, read once for `read`.
 */
export async function waterfallState(
  read: ContractReader = readContract,
): Promise<WaterfallStateView> {
  const asset = await dealAssetOf(read)();
  const toEurc = (baseUnits: bigint): number => toDisplayNumber(BigInt(baseUnits), asset.decimals);
  const config = (await read(environment.DEAL_CONTRACT_ID, 'get_config')) as DealConfigView;
  // The oracle of the deal. The setting is only a fallback.
  const oracle = config.oracle ?? environment.RATE_ORACLE_CONTRACT_ID;
  const [phase, reserve, carry, factors, outstanding, shortfalls, nextPeriod, wiring, fixing] =
    await Promise.all([
      read(environment.DEAL_CONTRACT_ID, 'get_state') as Promise<string>,
      read(environment.DEAL_CONTRACT_ID, 'get_reserve') as Promise<bigint>,
      read(environment.DEAL_CONTRACT_ID, 'get_carry') as Promise<bigint>,
      read(environment.DEAL_CONTRACT_ID, 'get_note_factors') as Promise<bigint[]>,
      read(environment.DEAL_CONTRACT_ID, 'get_outstanding') as Promise<bigint[]>,
      read(environment.DEAL_CONTRACT_ID, 'get_shortfalls') as Promise<bigint[]>,
      read(environment.DEAL_CONTRACT_ID, 'get_next_period') as Promise<number>,
      read(environment.DEAL_CONTRACT_ID, 'get_wiring') as Promise<{
        note_tokens: string[];
        paying_agent: string;
      } | null>,
      read(oracle, 'lastprice') as Promise<{
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
    const units = typeof raw === 'bigint' ? raw : BigInt(Number(raw ?? 0));
    const floating = variant !== 'Fixed';
    // No fixing: the interest of a floating class is not known yet.
    if (floating && !fixing) return 0;
    const annualRate = classRate(
      {
        rate: { kind: floating ? 'floating' : 'fixed', units },
        totalNotes: BigInt(terms.total_notes),
        floor: terms.floor ?? null,
        indexFloor: terms.index_floor ?? null,
      },
      fixing ? BigInt(fixing.price) : null,
    );
    return toEurc(accrue(BigInt(nominal), annualRate, Number(config.days_in_period)));
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
        (await read(config.asset, 'balance', [addressArg(agentId)])) as bigint,
      );
    } catch {
      // balance stays NaN - the rest of the view is still useful
    }
    const allocs: AllocView[] = [];
    if (lastPeriod !== null) {
      for (let classIndex = 0; classIndex < config.classes.length; classIndex++) {
        try {
          const alloc = (await read(agentId, 'get_alloc', [
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
    asset,
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


const runPeriodBody = z
  .object({
    // Overrides the pool collections, so that a small demo deal can run.
    // A decimal string in units of the deal asset, for example "12.5".
    collections: z
      .string()
      .regex(/^\d+(\.\d+)?$/, 'a decimal string such as "12.5" expected')
      .optional(),
    // The older form of the override: a number. `collections` replaces it.
    collectionsEurc: z.number().min(0).optional(),
  })
  .strict()
  .refine((body) => body.collections === undefined || body.collectionsEurc === undefined, {
    message: 'give collections or collectionsEurc, not both',
  });

type RunPeriodBody = z.infer<typeof runPeriodBody>;

/**
 * The collections of the period in base units of the deal asset: the
 * override of the body, or the pool collections. String math only.
 */
function collectionsBaseUnits(body: RunPeriodBody, poolCollected: number, decimals: number): bigint {
  if (body.collections !== undefined) return toBaseUnits(body.collections, decimals, 'collections');
  if (body.collectionsEurc !== undefined) {
    return numberToBaseUnits(body.collectionsEurc, decimals, 'collectionsEurc');
  }
  return numberToBaseUnits(poolCollected, decimals, 'The pool collections');
}

const pushDistributionBody = z.object({ period: z.number().int().min(1).optional() }).strict();

const previewQuery = z.object({
  // The collections of the next payment date, in units of the deal asset.
  collections: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'a decimal string such as "12.5" expected')
    .optional(),
});

/**
 * The next payment date, computed by the copy of the rank engine from the
 * ledgers on chain: the required reserve, the triggers, the payoff amount,
 * and with `collections` every rank line and the settlement. The servicer
 * sees the payment date before it signs.
 */
export async function enginePreview(read: ContractReader, collections?: string): Promise<EngineView | null> {
  const dealId = environment.DEAL_CONTRACT_ID;
  const config = decodeDealConfig(await read(dealId, 'get_config'));
  const state = await readEngineState(read, dealId, config);
  if (!state) return null;
  const asset = await dealAssetOf(read)();
  const fixing = state.phase === 'Matured' ? null : await readFixing(read, config);
  const amount = collections === undefined ? null : toBaseUnits(collections, asset.decimals, 'collections');
  return engineView(config, state, fixing, asset.decimals, amount);
}

function readableIssues(error: z.ZodError): string {
  const details = error.issues.map(
    (issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
  );
  return `The request body is not valid (${details.join('; ')}).`;
}

/** Notes on an incomplete crank follow-up. Empty when every batch is pushed. */
function pushNotes(progress: PushProgress): Record<string, unknown> {
  if (progress.complete) return {};
  return {
    pushesComplete: false,
    ...(progress.pending ? { pendingPush: progress.pending } : {}),
    ...(progress.failure ? { pushError: progress.failure.message } : {}),
  };
}

interface PeriodShape {
  period: number;
  classCount: number;
  /** The paying agent of the deal wiring. `push_batch` goes to it. */
  payingAgent: string;
}

/** The next period and the wiring of the deal. Null when the deal is not wired. */
async function periodShape(read: ContractReader): Promise<PeriodShape | null> {
  const wiring = await dealWiringOf(read)();
  if (!wiring) return null;
  const period = Number((await read(environment.DEAL_CONTRACT_ID, 'get_next_period')) as number);
  return { period, classCount: wiring.noteTokens.length, payingAgent: wiring.payingAgent };
}

const NOT_WIRED = 'Deal not wired';

/**
 * Bridge to the abs-deal contract (v4): the period collection computed from
 * the pool is cascaded on-chain through distribute() - fees, oracle-indexed
 * Class A interest (floor 0%), fixed B/C interest, full-cycle reserve,
 * sequential principal, residual to the seller. Interest AND principal go
 * to the paying agent contract of the deal wiring, which pushes the deal
 * asset to every noteholder.
 *
 * Each signed call goes through operator custody. A signature that waits
 * for an approval gives HTTP 202 with the operation; GET /operations/:id
 * then completes it.
 */
export function waterfallRoutes(services: OperatorServices): FastifyPluginAsync {
  const read: ContractReader = (contractId, method, args) =>
    services.network.read(contractId, method, args);
  const { operator } = services;

  return async (app) => {
    // Period preview: collections + the on-chain state they will meet. With
    // ?collections=<amount>, also every rank line of the next payment date.
    app.get('/waterfall/period-preview', async (request, reply) => {
      const query = previewQuery.safeParse(request.query ?? {});
      if (!query.success) return reply.status(400).send({ error: readableIssues(query.error) });
      const collections = periodCollections();
      let state: WaterfallStateView | null = null;
      try {
        state = await waterfallState(read);
      } catch {
        // RPC unavailable: the pool-side preview still renders
      }
      let engine: EngineView | null = null;
      let engineError: string | null = null;
      try {
        engine = await enginePreview(read, query.data.collections);
      } catch (error) {
        engineError = errorMessage(error);
      }
      return {
        dealContract: environment.DEAL_CONTRACT_ID,
        // The paying agent of the deal wiring. The setting is only a fallback.
        payingAgentContract: state?.payingAgent?.contractId ?? environment.PAYING_AGENT_CONTRACT_ID,
        rateOracle: environment.RATE_ORACLE_CONTRACT_ID,
        ...collections,
        onchain: state,
        engine,
        ...(engineError !== null ? { engineError } : {}),
        note: 'collected = installments of PERF loans with no arrears; missed = absorbed by the cascade (reserve first)',
      };
    });

    // The closing DvP: proceeds to the Seller, reserve funded from the
    // sub-loan, notes issued at par. The admin wallet signs.
    app.post('/waterfall/close-deal', async (_request, reply) => {
      try {
        const state = (await read(environment.DEAL_CONTRACT_ID, 'get_state')) as string;
        if (String(state).toUpperCase() !== 'FUNDING') {
          return reply.status(409).send({ error: `Deal is ${state}, not FUNDING` });
        }
        const operation = await operator.run(
          closeRequest(async (outcome) => ({
            closed: true,
            onchain: await waterfallState(read).catch(() => null),
            ...explorerLinks(outcome.hash),
          })),
        );
        return sendOperation(reply, operation);
      } catch (error) {
        return sendError(reply, error);
      }
    });

    // Runs the period: the servicer wallet signs distribute(period, collected).
    // When it is on chain, the crank wallet pushes every holder batch to the
    // paying agent of the deal wiring.
    app.post('/waterfall/run-period', async (request, reply) => {
      const body = runPeriodBody.safeParse(request.body ?? {});
      if (!body.success) return reply.status(400).send({ error: readableIssues(body.error) });
      const collections = periodCollections();
      const override = body.data.collections !== undefined || body.data.collectionsEurc !== undefined;
      if (!override && collections.collected <= 0) {
        return reply.status(409).send({ error: 'No collections to distribute' });
      }
      try {
        const asset = await dealAssetOf(read)();
        let amount: bigint;
        try {
          amount = collectionsBaseUnits(body.data, collections.collected, asset.decimals);
        } catch (error) {
          return reply.status(400).send({ error: errorMessage(error) });
        }
        const shape = await periodShape(read);
        if (!shape) return reply.status(409).send({ error: NOT_WIRED });
        const { period, classCount, payingAgent } = shape;
        const operation = await operator.run(
          distributeRequest(period, amount, async (outcome) => {
            const progress = await pushAllBatches(services, payingAgent, period, classCount);
            return {
              period,
              distributed: toDisplayNumber(amount, asset.decimals),
              distributedBaseUnits: amount.toString(),
              assetSymbol: asset.symbol,
              collectionsSource: override ? 'override' : 'pool',
              missed: override ? [] : collections.missed,
              perClass: jsonSafe(outcome.result),
              pushes: progress.pushes,
              ...pushNotes(progress),
              onchain: await waterfallState(read).catch(() => null),
              ...explorerLinks(outcome.hash),
            };
          }),
        );
        return sendOperation(reply, operation);
      } catch (error) {
        return sendError(reply, error);
      }
    });

    // Resume/retry the holder pushes of a period (idempotent: the contract's
    // cursor + per-holder markers make double-pay impossible).
    app.post('/waterfall/push-distribution', async (request, reply) => {
      const body = pushDistributionBody.safeParse(request.body ?? {});
      if (!body.success) return reply.status(400).send({ error: readableIssues(body.error) });
      try {
        const shape = await periodShape(read);
        if (!shape) return reply.status(409).send({ error: NOT_WIRED });
        const { period: nextPeriod, classCount, payingAgent } = shape;
        const period = body.data.period ?? nextPeriod - 1;
        if (period < 1) return reply.status(409).send({ error: 'No period executed yet' });
        const progress = await pushAllBatches(services, payingAgent, period, classCount);
        if (progress.pending) return reply.status(202).send(progress.pending);
        if (progress.failure) {
          const { status, message } = progress.failure;
          return reply.status(status).send({ error: message, pushes: progress.pushes });
        }
        return { period, pushes: progress.pushes, complete: true };
      } catch (error) {
        return sendError(reply, error);
      }
    });

    // Noteholder registry per class, proxied from the tranching-api indexer.
    app.get('/waterfall/holders', async (_request, reply) => {
      try {
        const wiring = await dealWiringOf(read)();
        if (!wiring) return reply.status(409).send({ error: NOT_WIRED });
        const classes = await Promise.all(
          wiring.noteTokens.map(async (noteId, classIndex) => {
            const response = await fetch(
              `${environment.TRANCHING_API_URL}/notes/${noteId}/holders`,
            );
            const holders = response.ok ? await response.json() : [];
            return { class: classIndex, noteContract: noteId, holders };
          }),
        );
        return { classes };
      } catch (error) {
        return sendError(reply, error);
      }
    });
  };
}
