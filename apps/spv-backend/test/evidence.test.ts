import { Asset, Keypair, Networks, StrKey, scValToNative, xdr } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeDealConfig, initialNotes } from '../src/deals/onchain.js';
import { allPassed, periodsOf, runChecks, type Check } from '../src/evidence/checks.js';
import { parseEvidenceArgs } from '../src/evidence/cli.js';
import { accountOperations } from '../src/evidence/collect.js';
import { fromBundle, toBundle, type ChainEvent, type Evidence, type HolderRow } from '../src/evidence/model.js';
import { renderReport, stepOf } from '../src/evidence/report.js';
import { requiredReserve } from '../src/waterfall/engine.js';
import { loadVector, type Vector } from './support/vectors.js';

const contract = (): string => StrKey.encodeContract(Keypair.random().rawPublicKey());
const account = (): string => Keypair.random().publicKey();
const CODE = { deal: 'aa'.repeat(32), note: 'bb'.repeat(32), agent: 'cc'.repeat(32) };

/**
 * The evidence of a vector deal. The events of the deal are the real events
 * of the contract tests. The events of the paying agent, of the note tokens
 * and of the oracle are written here in the form that these contracts
 * publish, with the amounts of the vector.
 */
function evidenceOf(vector: Vector, options: { enforcedAt?: number } = {}): Evidence {
  const config = decodeDealConfig(scValToNative(xdr.ScVal.fromXDR(vector.config_xdr, 'hex')));
  const { deal, paying_agent: payingAgent } = vector.contracts;
  const notes = config.classes.map(() => contract());
  const holders = config.classes.map(() => account());
  const events: ChainEvent[] = [];
  let sequence = 0;
  const publish = (contractId: string, type: string, topics: unknown[], data: unknown[], ledger: number, txHash: string): void => {
    sequence += 1;
    events.push({ contractId, type, topics, data, ledger, closedAt: 1_800_000_000 + ledger, txHash, id: String(sequence).padStart(10, '0') });
  };

  // The closing: the proceeds to the seller, the reserve, one issue for each class.
  const face = initialNotes(config);
  publish(deal, 'deal_closed', [], [face, requiredReserve(config, false, face), 1_800_000_000n], 100, 'tx-close');
  config.classes.forEach((terms, index) => {
    publish(notes[index] as string, 'issue', [holders[index]], [terms.totalNotes], 100, 'tx-close');
  });
  if (options.enforcedAt !== undefined) publish(deal, 'enforced', [], [options.enforcedAt], 105, 'tx-enforced');

  const interestPaid = config.classes.map(() => 0n);
  const principalPaid = config.classes.map(() => 0n);
  for (const period of vector.periods) {
    const ledger = 100 + period.period * 10;
    const txHash = `tx-period-${period.period}`;
    if (period.fixing !== null) publish(config.oracle, 'rate_set', [], [period.fixing, 0n], ledger - 1, `tx-rate-${period.period}`);
    for (const event of period.events) {
      const decoded = xdr.ContractEvent.fromXDR(event.xdr, 'hex').body().v0();
      const [name, ...topics] = decoded.topics().map((topic) => scValToNative(topic) as unknown);
      const data = scValToNative(decoded.data()) as unknown;
      publish(deal, String(name), topics, Array.isArray(data) ? data : [data], ledger, txHash);
    }
    // The paying agent: one period_funded for each class, then the pushes.
    config.classes.forEach((_terms, index) => {
      const paidOf = (kind: 'Interest' | 'Principal'): bigint =>
        period.lines.filter((line) => line[1][0] === kind && line[1][1] === index).reduce((total, line) => total + line[3], 0n);
      const interest = paidOf('Interest');
      const principal = paidOf('Principal');
      publish(payingAgent, 'period_funded', [period.period], [index, interest, principal, 0n], ledger, txHash);
      const pushHash = `tx-push-${period.period}-${index}`;
      publish(payingAgent, 'holder_paid', [holders[index]], [period.period, index, interest, principal], ledger + 1, pushHash);
      publish(payingAgent, 'batch_done', [period.period], [index, 1, true], ledger + 1, pushHash);
      interestPaid[index] = (interestPaid[index] as bigint) + interest;
      principalPaid[index] = (principalPaid[index] as bigint) + principal;
    });
  }

  const last = vector.periods.at(-1);
  if (!last) throw new Error('The vector has no period.');
  const rows: HolderRow[] = holders.map((holder, index) => ({
    class: index,
    holder,
    notes: config.classes[index]?.totalNotes ?? 0n,
    interestPaid: interestPaid[index] as bigint,
    principalPaid: principalPaid[index] as bigint,
    claimableInterest: 0n,
    claimablePrincipal: 0n,
  }));
  return {
    label: `Vector ${vector.name}`,
    network: 'testnet',
    collectedAt: '2026-11-23T00:00:00.000Z',
    fromLedger: 90,
    latestLedger: 1000,
    snapshot: {
      deal,
      payingAgent,
      notes,
      asset: { contractId: vector.contracts.asset, symbol: 'EURC', decimals: 7 },
      config,
      reporter: account(),
      crank: null,
      fixingHistory: [],
      state: last.closing.state,
      nextPeriod: last.period + 1,
      reserve: last.closing.reserve,
      carry: last.closing.carry,
      owedTotal: last.closing.owed,
      balance: last.closing.balance,
      agentBalance: 0n,
      perNote: last.closing.per_note,
      shortfall: last.closing.shortfall,
      dust: config.classes.map(() => 0n),
      holders: rows,
      code: CODE,
      compare: [{ deal: contract(), code: CODE }],
    },
    events,
    transactions: [],
    accounts: [],
    fixings: {},
  };
}

const statusOf = (checks: readonly Check[], id: string): string => checks.find((check) => check.id === id)?.status ?? 'missing';

/** Changes one value of the data of one event. */
function tamper(evidence: Evidence, type: string, period: number, change: (data: unknown[]) => void): Evidence {
  const copy = fromBundle(toBundle(evidence));
  const event = copy.events.find((candidate) => candidate.type === type && candidate.txHash === `tx-period-${period}`);
  if (!event) throw new Error(`No ${type} event in period ${period}.`);
  change(event.data);
  return copy;
}

describe('the checks of the evidence of a deal', () => {
  const plain = ['deal-s', 'deal-p', 'reference', 'pro-rata-then-sequential', 'percent-reserve-on-need', 'two-fee-lines', 'largest-structure', 'maturity-with-a-surplus', 'parked-fee'];

  it.each(plain)('passes on the events of the vector "%s"', (name) => {
    const checks = runChecks(evidenceOf(loadVector(name)));
    expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
    for (const id of ['B1', 'R1', 'L1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'H1', 'H2', 'H3', 'H4']) {
      expect(statusOf(checks, id), `${name} ${id}`).toBe('pass');
    }
    expect(allPassed(checks)).toBe(true);
  });

  it('replays a deal through its enforcement', () => {
    // The admin declares the enforcement before period 2.
    const checks = runChecks(evidenceOf(loadVector('reference-enforced'), { enforcedAt: 2 }));
    expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(statusOf(checks, 'C8')).toBe('pass');
    // Without the enforcement event, the replay runs the normal order: it differs.
    const missing = runChecks(evidenceOf(loadVector('reference-enforced')));
    expect(statusOf(missing, 'C8')).toBe('fail');
  });

  it('checks the ledgers of a matured deal', () => {
    expect(statusOf(runChecks(evidenceOf(loadVector('deal-s'))), 'L2')).toBe('pass');
    expect(statusOf(runChecks(evidenceOf(loadVector('deal-p'))), 'L2')).toBe('pass');
    expect(statusOf(runChecks(evidenceOf(loadVector('two-fee-lines'))), 'L2')).toBe('skip');
  });

  it('reads each payment date from its transaction', () => {
    const periods = periodsOf(evidenceOf(loadVector('deal-p')));
    expect(periods.map((period) => [period.period, period.breached, period.lines.length])).toEqual([
      [1, [], 8],
      [2, [], 8],
      [3, ['seq'], 8],
      [4, [], 9],
    ]);
    expect(periods[2]?.lines.filter((line) => line.item.kind === 'principal').map((line) => line.rank)).toEqual([
      'prin_seq',
      'prin_seq',
      'prin_seq',
    ]);
  });

  it('fails when a figure of an event is changed', () => {
    const evidence = evidenceOf(loadVector('deal-p'));
    // A settlement that does not balance.
    const reserve = tamper(evidence, 'period_settled', 1, (data) => {
      data[5] = (data[5] as bigint) + 1n;
    });
    expect(statusOf(runChecks(reserve), 'C4')).toBe('fail');
    // A balance below the ledgers.
    const balance = tamper(evidence, 'period_settled', 2, (data) => {
      data[8] = 0n;
    });
    expect(statusOf(runChecks(balance), 'C5')).toBe('fail');
    // A line that pays more than its due.
    const line = tamper(evidence, 'rank_lines', 1, (data) => {
      const lines = data[1] as unknown[][];
      (lines[0] as unknown[])[3] = ((lines[0] as unknown[])[2] as bigint) + 1n;
    });
    const lineChecks = runChecks(line);
    expect(statusOf(lineChecks, 'C3')).toBe('fail');
    expect(statusOf(lineChecks, 'C8')).toBe('fail');
    // Lines in another order.
    const order = tamper(evidence, 'rank_lines', 1, (data) => {
      (data[1] as unknown[]).reverse();
    });
    expect(statusOf(runChecks(order), 'C2')).toBe('fail');
    // Other collections in the earlier event.
    const collections = tamper(evidence, 'distribution', 3, (data) => {
      data[0] = 1n;
    });
    expect(statusOf(runChecks(collections), 'C6')).toBe('fail');
    // Another interest in the paying agent.
    const funded = tamper(evidence, 'period_funded', 1, (data) => {
      data[1] = (data[1] as bigint) + 1n;
    });
    expect(statusOf(runChecks(funded), 'C7')).toBe('fail');
  });

  it('fails on another code, on one address in two roles and on a wrong holder counter', () => {
    const evidence = evidenceOf(loadVector('deal-s'));
    const code = fromBundle(toBundle(evidence));
    (code.snapshot.compare[0] as { code: { deal: string } }).code.deal = 'dd'.repeat(32);
    expect(statusOf(runChecks(code), 'B1')).toBe('fail');
    const role = fromBundle(toBundle(evidence));
    role.snapshot.reporter = role.snapshot.config.servicer;
    expect(statusOf(runChecks(role), 'R1')).toBe('fail');
    const counter = fromBundle(toBundle(evidence));
    (counter.snapshot.holders[0] as HolderRow).interestPaid += 1n;
    expect(statusOf(runChecks(counter), 'H1')).toBe('fail');
    const batch = fromBundle(toBundle(evidence));
    batch.events = batch.events.filter((event) => !(event.type === 'batch_done' && event.txHash === 'tx-push-1-0'));
    expect(statusOf(runChecks(batch), 'H3')).toBe('fail');
    const ledgers = fromBundle(toBundle(evidence));
    ledgers.snapshot.reserve = 1n;
    expect(statusOf(runChecks(ledgers), 'L2')).toBe('fail');
  });

  it('takes a fixing from the history of the oracle when its event is outside the window', () => {
    const evidence = evidenceOf(loadVector('deal-s'));
    const fixing = loadVector('deal-s').periods[0]?.fixing ?? 0n;
    // No rate_set event in the window.
    evidence.events = evidence.events.filter((event) => event.type !== 'rate_set');
    expect(statusOf(runChecks(evidence), 'C8')).toBe('skip');
    // The oracle published this fixing before the first payment date.
    evidence.snapshot.fixingHistory = [
      { price: 1n, timestamp: 1_700_000_000n },
      { price: fixing, timestamp: 1_800_000_100n },
      { price: 9999n, timestamp: 1_900_000_000n },
    ];
    expect(statusOf(runChecks(evidence), 'C8')).toBe('pass');
  });

  it('skips the checks that need the closing when the window starts later', () => {
    const evidence = evidenceOf(loadVector('deal-p'));
    evidence.events = evidence.events.filter((event) => event.ledger >= 120);
    const checks = runChecks(evidence);
    expect(statusOf(checks, 'L1')).toBe('skip');
    expect(statusOf(checks, 'C8')).toBe('skip');
    expect(statusOf(checks, 'H1')).toBe('skip');
    // The deal ran 4 periods, the window has 3: this is a failure, not a skip.
    expect(statusOf(checks, 'C1')).toBe('fail');
  });
});

describe('the report of the evidence', () => {
  const evidence = evidenceOf(loadVector('deal-p'));
  const report = renderReport(evidence, runChecks(evidence));

  it('gives the rank lines and the settlement of each period in units of the asset', () => {
    expect(report).toContain('### Vector deal-p');
    expect(report).toContain('#### Period 1: normal order');
    expect(report).toContain('| `prin_pr` | Principal, Class A | 600 | 180.42 | 0.0573001 |');
    expect(report).toContain('Triggers set in this period: `seq`.');
    expect(report).toContain('| `prin_seq` | Principal, Class A | 229.44 | 117.84 | 0.008516 |');
    expect(report).toContain('Conservation: 305 + 50 + 0 = 304.8633333 + 50 + 0.1366667.');
    expect(report).toContain('| C8 A replay with the copy of the engine gives the same lines | PASS |');
    expect(report).not.toMatch(/—/);
  });

  it('keeps every figure through the bundle file', () => {
    const again = fromBundle(toBundle(evidence));
    expect(again).toEqual(evidence);
    expect(renderReport(again, runChecks(again))).toBe(report);
  });

  it('names a transaction from its events', () => {
    const event = (type: string, topics: unknown[], data: unknown[]): ChainEvent => ({
      contractId: 'C',
      type,
      topics,
      data,
      ledger: 1,
      closedAt: 0,
      txHash: 'tx',
      id: '1',
    });
    expect(stepOf([event('subscribed', ['G'], [1, 3n, 30n])])).toBe('subscribe, Class B, 3 note(s)');
    expect(stepOf([event('period_settled', [2], []), event('matured', [], [2])])).toBe('distribute, period 2 (maturity)');
    expect(stepOf([event('holder_paid', ['G'], []), event('push_failed', ['G'], []), event('batch_done', [1], [0, 2, true])])).toBe(
      'push_batch, period 1, Class A, 1 push failed',
    );
    expect(stepOf([event('deal_closed', [], []), event('issue', ['G'], [1n])])).toBe('close (closing DvP)');
    expect(stepOf([event('claimed', ['G'], [1, 1n, 1n])])).toBe('claim (paying agent)');
  });
});

describe('deal:evidence arguments', () => {
  const deal = contract();

  it('takes the deal of the setting, lists of deals and accounts, and fixings', () => {
    expect(parseEvidenceArgs([], deal)).toMatchObject({ deal, compareDeals: [], accounts: [], fixings: {}, bundle: null });
    const other = contract();
    const holder = account();
    const parsed = parseEvidenceArgs(
      ['--deal', other, '--compare-code', `${deal}, ${other}`, '--account', holder, '--fixing', '1=2209,2=-10', '--from-ledger', '12', '--out', 'e.md'],
      deal,
    );
    expect(parsed).toMatchObject({
      deal: other,
      compareDeals: [deal, other],
      accounts: [holder],
      fixings: { 1: 2209n, 2: -10n },
      fromLedger: 12,
      out: 'e.md',
    });
  });

  it('refuses a wrong address, ledger or fixing', () => {
    expect(() => parseEvidenceArgs(['--deal', account()], deal)).toThrow(/not a contract address/);
    expect(() => parseEvidenceArgs(['--account', deal], deal)).toThrow(/not an account address/);
    expect(() => parseEvidenceArgs(['--from-ledger', '0'], deal)).toThrow(/not a ledger number/);
    expect(() => parseEvidenceArgs(['--fixing', '2209'], deal)).toThrow(/<period>=<rate units>/);
  });
});

describe('the operations of an account in the report', () => {
  const dealAsset = new Asset('EURC', 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO');
  const otherAsset = new Asset('EURC', 'GCB6FLVHX7OXWSUHP76WGPVOJLGPB6FGXAQKMVSWPNP6NFUWNOHQMXQA');
  const assetId = { contractId: dealAsset.contractId(Networks.TESTNET), networkPassphrase: Networks.TESTNET };
  const operation = (token: number, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    paging_token: String(token),
    type: 'payment',
    transaction_hash: `tx${token}`,
    transaction_successful: true,
    created_at: '2026-11-23T20:00:00Z',
    ...fields,
  });
  const trust = (asset: Asset, limit: string): Record<string, unknown> => ({
    type: 'change_trust',
    asset_code: asset.getCode(),
    asset_issuer: asset.getIssuer(),
    limit,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts at the first ledger of the deal and keeps the trustlines of the deal asset only', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url);
        const records = [
          operation(1, trust(otherAsset, '0.0000000')),
          operation(2, trust(dealAsset, '0.0000000')),
          operation(3, trust(dealAsset, '922337203685.4775807')),
          operation(4),
        ];
        return Promise.resolve(new Response(JSON.stringify({ _embedded: { records } })));
      }),
    );
    const rows = await accountOperations('https://horizon.test', account(), 5_000, assetId);
    expect(new URL(String(urls[0])).searchParams.get('cursor')).toBe((5_000n << 32n).toString());
    expect(rows.map((row) => row.what)).toEqual(['change_trust EURC (removed)', 'change_trust EURC', 'payment']);
    expect(rows.map((row) => row.hash)).toEqual(['tx2', 'tx3', 'tx4']);
  });

  it('reads every page', async () => {
    const pages = [Array.from({ length: 200 }, (_, index) => operation(index + 1)), [operation(201)]];
    const cursors: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        cursors.push(new URL(url).searchParams.get('cursor'));
        const records = pages[cursors.length - 1] ?? [];
        return Promise.resolve(new Response(JSON.stringify({ _embedded: { records } })));
      }),
    );
    const rows = await accountOperations('https://horizon.test', account(), 1, assetId);
    expect(rows).toHaveLength(201);
    expect(cursors[1]).toBe('200');
  });
});
