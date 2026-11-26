import { Asset, TransactionBuilder, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { z } from 'zod';
import type { StellarNetwork } from '../custody/ports.js';
import { readAssetInfo } from '../deals/assets.js';
import { decodeDealConfig, hasFloatingClass } from '../deals/onchain.js';
import { addressArg, u32Arg } from '../waterfall/soroban.js';
import { stepOf } from './report.js';
import {
  inChainOrder,
  type AccountOperation,
  type ChainEvent,
  type CodeHashes,
  type DealSnapshot,
  type Evidence,
  type HolderRow,
  type TransactionRow,
} from './model.js';

/**
 * Reads the evidence of one deal from the network: Soroban RPC for the
 * state and the events, Horizon for the operations of an account. The
 * module signs nothing and sends no transaction.
 */
type ContractReader = StellarNetwork['read'];

export interface CollectServices {
  server: rpc.Server;
  read: ContractReader;
  /** The wasm hash of a deployed contract. */
  codeHashOf(contractId: string): Promise<Buffer>;
  networkPassphrase: string;
  horizonUrl: string;
}

export interface CollectOptions {
  deal: string;
  label: string;
  network: string;
  /** Other deals: their code must be the code of this deal. */
  compareDeals: string[];
  /** The first ledger of the event window. Null: the oldest ledger of the RPC. */
  fromLedger: number | null;
  /** The transactions of the deploy, which publish no event. */
  deployTransactions: { kind: string; hash: string }[];
  /** The crank of the deploy record. Null when not known. */
  crank: string | null;
  /** Accounts whose operations go in the report. */
  accounts: string[];
  fixings: Record<number, bigint>;
}

/** Soroban RPC takes at most 5 contract ids in one filter, and 5 filters. */
const IDS_PER_FILTER = 5;
const EVENTS_PER_PAGE = 200;
const MAX_PAGES = 2000;

async function codeOf(read: ContractReader, codeHashOf: CollectServices['codeHashOf'], deal: string): Promise<CodeHashes> {
  const wiring = (await read(deal, 'get_wiring')) as { note_tokens: string[]; paying_agent: string } | null;
  if (!wiring || wiring.note_tokens.length === 0) {
    throw new Error(`The deal ${deal} is not wired: its note and paying agent code is not known.`);
  }
  const [dealCode, agentCode, noteCodes] = await Promise.all([
    codeHashOf(deal),
    codeHashOf(wiring.paying_agent),
    Promise.all(wiring.note_tokens.map((token) => codeHashOf(token))),
  ]);
  // The report shows one note code, so every class must run it.
  const notes = new Set(noteCodes.map((code) => code.toString('hex')));
  const [note] = notes;
  if (note === undefined || notes.size !== 1) {
    throw new Error(`The note tokens of the deal ${deal} do not all run one code.`);
  }
  return { deal: dealCode.toString('hex'), note, agent: agentCode.toString('hex') };
}

/** Every event of the contracts from `fromLedger`, in chain order. */
export async function collectEvents(
  server: rpc.Server,
  contractIds: readonly string[],
  fromLedger: number,
): Promise<{ events: ChainEvent[]; latestLedger: number }> {
  const filters: rpc.Api.EventFilter[] = [];
  for (let start = 0; start < contractIds.length; start += IDS_PER_FILTER) {
    filters.push({ type: 'contract', contractIds: contractIds.slice(start, start + IDS_PER_FILTER) });
  }
  const events: ChainEvent[] = [];
  let cursor: string | undefined;
  let latestLedger = fromLedger;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = cursor
      ? await server.getEvents({ cursor, filters, limit: EVENTS_PER_PAGE })
      : await server.getEvents({ startLedger: fromLedger, filters, limit: EVENTS_PER_PAGE });
    latestLedger = response.latestLedger;
    for (const event of response.events) {
      // A recent RPC does not send `inSuccessfulContractCall`: it returns
      // only the events of successful calls. An older RPC marks the others.
      if ((event.inSuccessfulContractCall as boolean | undefined) === false || !event.contractId) continue;
      const [name, ...topics] = event.topic.map((topic: xdr.ScVal) => scValToNative(topic) as unknown);
      const data = scValToNative(event.value) as unknown;
      events.push({
        contractId: event.contractId.contractId(),
        type: String(name),
        topics,
        data: Array.isArray(data) ? data : [data],
        ledger: event.ledger,
        closedAt: Math.floor(Date.parse(event.ledgerClosedAt) / 1000) || 0,
        txHash: event.txHash,
        id: event.id,
      });
    }
    // The cursor moves through the ledgers on each page, also on an empty
    // page. It stops when the window is read to the end.
    if (!response.cursor || response.cursor === cursor) break;
    cursor = response.cursor;
  }
  return { events: inChainOrder(events), latestLedger };
}

/** The source account of a transaction: who signed it. Null when the RPC does not have it. */
async function signerOf(services: CollectServices, hash: string): Promise<{ signer: string | null; ledger: number | null }> {
  try {
    const response = await services.server.getTransaction(hash);
    if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) return { signer: null, ledger: null };
    const transaction = TransactionBuilder.fromXDR(response.envelopeXdr.toXDR('base64'), services.networkPassphrase);
    const inner = 'innerTransaction' in transaction ? transaction.innerTransaction : transaction;
    return { signer: inner.source, ledger: response.ledger };
  } catch {
    return { signer: null, ledger: null };
  }
}

const horizonOperations = z.object({
  _embedded: z.object({
    records: z.array(
      z.object({
        paging_token: z.string(),
        type: z.string(),
        transaction_hash: z.string(),
        transaction_successful: z.boolean(),
        created_at: z.string(),
        function: z.string().optional(),
        asset_code: z.string().optional(),
        asset_issuer: z.string().optional(),
        limit: z.string().optional(),
        parameters: z.array(z.object({ value: z.string(), type: z.string() })).optional(),
      }),
    ),
  }),
});

const OPERATIONS_PER_PAGE = 200;

/** The asset of the deal. The report keeps the trustline operations on this asset only. */
export interface DealAssetId {
  contractId: string;
  networkPassphrase: string;
}

function isDealAsset(record: { asset_code?: string | undefined; asset_issuer?: string | undefined }, asset: DealAssetId): boolean {
  if (record.asset_code === undefined || record.asset_issuer === undefined) return false;
  return new Asset(record.asset_code, record.asset_issuer).contractId(asset.networkPassphrase) === asset.contractId;
}

/**
 * The operations of one account from the first ledger of the deal, oldest
 * first, from Horizon. A trustline operation counts only for the asset of
 * the deal, because an account can hold another asset with the same code.
 */
export async function accountOperations(
  horizonUrl: string,
  account: string,
  fromLedger: number,
  asset: DealAssetId,
): Promise<AccountOperation[]> {
  const operations: AccountOperation[] = [];
  // A Horizon cursor is a TOID. The ledger sequence is in its upper 32 bits.
  let cursor = (BigInt(fromLedger) << 32n).toString();
  for (;;) {
    const response = await fetch(
      `${horizonUrl}/accounts/${account}/operations?order=asc&limit=${OPERATIONS_PER_PAGE}&include_failed=true&cursor=${cursor}`,
    );
    if (!response.ok) throw new Error(`Horizon answered HTTP ${response.status} for the operations of ${account}.`);
    const { records } = horizonOperations.parse(await response.json())._embedded;
    for (const record of records) {
      if (record.type === 'change_trust' && !isDealAsset(record, asset)) continue;
      let what = record.type;
      if (record.type === 'change_trust') {
        what = `change_trust ${record.asset_code ?? ''}${record.limit !== undefined && Number(record.limit) === 0 ? ' (removed)' : ''}`;
      } else if (record.type === 'invoke_host_function') {
        // The second parameter of a contract call is the name of the function.
        const name = record.parameters?.[1];
        what = name ? String(scValToNative(xdr.ScVal.fromXDR(name.value, 'base64'))) : 'contract call';
      }
      operations.push({
        account,
        hash: record.transaction_hash,
        createdAt: record.created_at,
        what,
        successful: record.transaction_successful,
      });
    }
    const last = records.at(-1);
    if (last === undefined || records.length < OPERATIONS_PER_PAGE) return operations;
    cursor = last.paging_token;
  }
}

/** Reads the state of the deal and the counters of each holder. */
async function collectSnapshot(
  services: CollectServices,
  options: CollectOptions,
  events: readonly ChainEvent[],
  payingAgent: string,
  notes: string[],
): Promise<DealSnapshot> {
  const { read, codeHashOf } = services;
  const { deal } = options;
  const config = decodeDealConfig(await read(deal, 'get_config'));
  const asset = await readAssetInfo(read, config.asset);
  const optional = async <T>(load: () => Promise<unknown>, fallback: T): Promise<T> => {
    try {
      return ((await load()) as T) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const [state, nextPeriod, reserve, carry, classStates, balance, agentBalance, owedTotal] = await Promise.all([
    read(deal, 'get_state'),
    read(deal, 'get_next_period') as Promise<number>,
    read(deal, 'get_reserve') as Promise<bigint>,
    read(deal, 'get_carry') as Promise<bigint>,
    optional<{ per_note_outstanding: bigint; shortfall: bigint }[]>(() => read(deal, 'get_class_states'), []),
    read(config.asset, 'balance', [addressArg(deal)]) as Promise<bigint>,
    read(config.asset, 'balance', [addressArg(payingAgent)]) as Promise<bigint>,
    optional<bigint>(() => read(deal, 'get_owed_total'), 0n),
  ]);
  const reporter = hasFloatingClass(config) ? await optional<string | null>(() => read(config.oracle, 'get_reporter'), null) : null;
  // The oracle keeps its last 12 fixings.
  const history = hasFloatingClass(config)
    ? await optional<{ price: bigint; timestamp: bigint }[]>(() => read(config.oracle, 'prices', [u32Arg(12)]), [])
    : [];

  // A holder is an address that holds notes now, or that the paying agent paid.
  const holders: HolderRow[] = [];
  const dust: bigint[] = [];
  for (const [classIndex, note] of notes.entries()) {
    const current = (await read(note, 'holders')) as string[];
    const paid = events
      .filter(
        (event) =>
          event.contractId === payingAgent &&
          ['holder_paid', 'push_failed', 'claimed'].includes(event.type) &&
          Number(event.type === 'claimed' ? event.data[0] : event.data[1]) === classIndex,
      )
      .map((event) => String(event.topics[0]));
    for (const holder of new Set([...current, ...paid])) {
      const [noteBalance, totals, claimable] = await Promise.all([
        read(note, 'balance', [addressArg(holder)]) as Promise<bigint>,
        read(payingAgent, 'get_holder_totals', [u32Arg(classIndex), addressArg(holder)]) as Promise<{
          interest_paid: bigint;
          principal_paid: bigint;
        }>,
        read(payingAgent, 'get_claimable', [u32Arg(classIndex), addressArg(holder)]) as Promise<{
          interest: bigint;
          principal: bigint;
        }>,
      ]);
      holders.push({
        class: classIndex,
        holder,
        notes: BigInt(noteBalance),
        interestPaid: BigInt(totals.interest_paid),
        principalPaid: BigInt(totals.principal_paid),
        claimableInterest: BigInt(claimable.interest),
        claimablePrincipal: BigInt(claimable.principal),
      });
    }
    dust.push(BigInt((await read(payingAgent, 'get_dust', [u32Arg(classIndex)])) as bigint));
  }

  const compare = [];
  for (const other of options.compareDeals) {
    compare.push({ deal: other, code: await codeOf(read, codeHashOf, other) });
  }
  return {
    deal,
    payingAgent,
    notes,
    asset: { contractId: asset.contractId, symbol: asset.symbol, decimals: asset.decimals },
    config,
    reporter,
    crank: options.crank,
    fixingHistory: history.map((fixing) => ({ price: BigInt(fixing.price), timestamp: BigInt(fixing.timestamp) })),
    state: String(state),
    nextPeriod: Number(nextPeriod),
    reserve: BigInt(reserve),
    carry: BigInt(carry),
    owedTotal: BigInt(owedTotal),
    balance: BigInt(balance),
    agentBalance: BigInt(agentBalance),
    perNote: classStates.map((entry) => BigInt(entry.per_note_outstanding)),
    shortfall: classStates.map((entry) => BigInt(entry.shortfall)),
    dust,
    holders,
    code: await codeOf(read, codeHashOf, deal),
    compare,
  };
}

/** Reads the whole evidence of one deal. */
export async function collectEvidence(services: CollectServices, options: CollectOptions): Promise<Evidence> {
  const { read, server } = services;
  const config = decodeDealConfig(await read(options.deal, 'get_config'));
  const wiring = (await read(options.deal, 'get_wiring')) as { note_tokens: string[]; paying_agent: string } | null;
  if (!wiring) throw new Error(`The deal ${options.deal} is not wired.`);

  // The event window: from the given ledger, or from the first transaction
  // of the deploy, or from the oldest ledger that the RPC keeps.
  const health = await server.getHealth();
  let start = options.fromLedger;
  const firstDeploy = options.deployTransactions[0];
  if (start === null && firstDeploy) start = (await signerOf(services, firstDeploy.hash)).ledger;
  const fromLedger = Math.max(start ?? health.oldestLedger, health.oldestLedger);
  const contracts = [options.deal, wiring.paying_agent, ...wiring.note_tokens, config.oracle];
  const { events, latestLedger } = await collectEvents(server, contracts, fromLedger);
  const snapshot = await collectSnapshot(services, options, events, wiring.paying_agent, wiring.note_tokens);

  // One row for each transaction: the deploy first, then the events in chain order.
  const transactions: TransactionRow[] = [];
  for (const entry of options.deployTransactions) {
    transactions.push({ hash: entry.hash, step: entry.kind, ...(await signerOf(services, entry.hash)) });
  }
  const seen = new Set(transactions.map((row) => row.hash));
  for (const event of events) {
    if (seen.has(event.txHash)) continue;
    seen.add(event.txHash);
    const ofTransaction = events.filter((candidate) => candidate.txHash === event.txHash);
    const { signer } = await signerOf(services, event.txHash);
    transactions.push({ hash: event.txHash, ledger: event.ledger, step: stepOf(ofTransaction), signer });
  }

  const accounts: AccountOperation[] = [];
  for (const account of options.accounts) {
    accounts.push(
      ...(await accountOperations(services.horizonUrl, account, fromLedger, {
        contractId: snapshot.asset.contractId,
        networkPassphrase: services.networkPassphrase,
      })),
    );
  }
  return {
    label: options.label,
    network: options.network,
    collectedAt: new Date().toISOString(),
    fromLedger,
    latestLedger,
    snapshot,
    events,
    transactions,
    accounts,
    fixings: options.fixings,
  };
}
