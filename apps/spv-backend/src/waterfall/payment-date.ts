import { environment } from '../config.js';
import { errorMessage, errorStatus } from '../custody/errors.js';
import type { Operation } from '../custody/operations.js';
import type { OperatorRequest } from '../custody/operator.js';
import type { ChainOutcome, StellarNetwork } from '../custody/ports.js';
import type { OperatorServices } from '../custody/services.js';
import { readAssetInfo } from '../deals/assets.js';
import { i128Arg, u32Arg } from './soroban.js';

/**
 * The operator requests of a payment date. Each request names the role that
 * signs it: admin closes the deal, servicer runs `distribute`, crank pushes
 * the holder batches of the paying agent.
 *
 * Amounts go to the contracts in base units of the deal asset. The asset
 * decimals come from the asset contract, never from a constant.
 */
const HOLDERS_PER_BATCH = 10;
const MAX_BATCHES_PER_CLASS = 50;

type Finish = (outcome: ChainOutcome) => Promise<unknown>;
type ContractReader = StellarNetwork['read'];

export interface Push {
  hash: string;
  class: number;
  cursor: number;
}

export interface PushProgress {
  pushes: Push[];
  complete: boolean;
  /** A crank signature that waits for an approval. The crank wallet normally has no policy. */
  pending: Operation | null;
  failure: { message: string; status: number } | null;
}

/** The settlement asset of the deal, as its contract describes it. */
export interface DealAsset {
  contractId: string;
  symbol: string;
  decimals: number;
}

/** The contracts that `set_wiring` attached to the deal. */
export interface DealWiring {
  noteTokens: string[];
  payingAgent: string;
}

/** Keeps the first result. A failed load runs again at the next call. */
export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

/** Reads the asset of the deal (`get_config`), then its symbol and decimals. */
export async function readDealAsset(
  read: ContractReader,
  dealId: string = environment.DEAL_CONTRACT_ID,
): Promise<DealAsset> {
  const config = (await read(dealId, 'get_config')) as { asset: string };
  const { contractId, symbol, decimals } = await readAssetInfo(read, config.asset);
  return { contractId, symbol, decimals };
}

/** Reads `get_wiring`. Null when the deal is not wired yet. */
export async function readDealWiring(
  read: ContractReader,
  dealId: string = environment.DEAL_CONTRACT_ID,
): Promise<DealWiring | null> {
  const wiring = (await read(dealId, 'get_wiring')) as {
    note_tokens: string[];
    paying_agent: string;
  } | null;
  return wiring ? { noteTokens: wiring.note_tokens, payingAgent: wiring.paying_agent } : null;
}

// One cache for each reader. The asset and the wiring of a deal never change.
const assetCaches = new WeakMap<ContractReader, () => Promise<DealAsset>>();
const wiringCaches = new WeakMap<ContractReader, () => Promise<DealWiring | null>>();

/** The deal asset, read once with `read` and then kept. */
export function dealAssetOf(read: ContractReader): () => Promise<DealAsset> {
  let cached = assetCaches.get(read);
  if (!cached) {
    cached = once(() => readDealAsset(read));
    assetCaches.set(read, cached);
  }
  return cached;
}

/** The deal wiring, read with `read`. It is kept after the deal is wired. */
export function dealWiringOf(read: ContractReader): () => Promise<DealWiring | null> {
  let cached = wiringCaches.get(read);
  if (!cached) {
    let wiring: DealWiring | null = null;
    cached = async () => {
      wiring ??= await readDealWiring(read);
      return wiring;
    };
    wiringCaches.set(read, cached);
  }
  return cached;
}

export function explorerLinks(hash: string): { transactionHash: string; explorer: string } {
  return { transactionHash: hash, explorer: `https://stellar.expert/explorer/testnet/tx/${hash}` };
}

export function closeRequest(finish: Finish): OperatorRequest {
  return {
    kind: 'close-deal',
    role: 'admin',
    call: { type: 'contract', contractId: environment.DEAL_CONTRACT_ID, method: 'close', args: [] },
    finish,
  };
}

/** `collections` is in base units of the deal asset. */
export function distributeRequest(
  period: number,
  collections: bigint,
  finish: Finish,
): OperatorRequest {
  return {
    kind: 'run-period',
    role: 'servicer',
    call: {
      type: 'contract',
      contractId: environment.DEAL_CONTRACT_ID,
      method: 'distribute',
      args: [u32Arg(period), i128Arg(collections)],
    },
    finish,
  };
}

/** `payingAgent` is the paying agent of the deal wiring. */
export function pushBatchRequest(
  payingAgent: string,
  period: number,
  classIndex: number,
): OperatorRequest {
  return {
    kind: 'push-distribution',
    role: 'crank',
    call: {
      type: 'contract',
      contractId: payingAgent,
      method: 'push_batch',
      args: [u32Arg(period), u32Arg(classIndex), u32Arg(HOLDERS_PER_BATCH)],
    },
  };
}

/**
 * Cranks the paying agent of the deal until every class of `period` is
 * pushed. The contract cursor and the per-holder markers make a double
 * payment impossible, so a second run resumes where the first one stopped.
 */
export async function pushAllBatches(
  services: OperatorServices,
  payingAgent: string,
  period: number,
  classCount: number,
): Promise<PushProgress> {
  const pushes: Push[] = [];
  try {
    for (let classIndex = 0; classIndex < classCount; classIndex++) {
      for (let batch = 0; batch < MAX_BATCHES_PER_CLASS; batch++) {
        const alloc = (await services.network.read(payingAgent, 'get_alloc', [
          u32Arg(period),
          u32Arg(classIndex),
        ])) as { done: boolean } | null;
        if (!alloc || alloc.done) break;
        const operation = await services.operator.run(
          pushBatchRequest(payingAgent, period, classIndex),
        );
        if (operation.status !== 'done') return stopped(pushes, operation);
        const cursor = Number(operation.result ?? 0);
        pushes.push({ hash: operation.hash ?? '', class: classIndex, cursor });
      }
    }
  } catch (error) {
    const failure = { message: errorMessage(error), status: errorStatus(error) };
    return { pushes, complete: false, pending: null, failure };
  }
  return { pushes, complete: true, pending: null, failure: null };
}

function stopped(pushes: Push[], operation: Operation): PushProgress {
  if (operation.status === 'awaiting_approval') {
    return { pushes, complete: false, pending: operation, failure: null };
  }
  const message = operation.error ?? `The push batch ended as ${operation.status}.`;
  return { pushes, complete: false, pending: null, failure: { message, status: 502 } };
}
