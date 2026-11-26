import { formatUnits } from '../deals/amounts.js';
import type { OnChainItem } from '../deals/onchain.js';
import { periodsOf, type Check } from './checks.js';
import type { ChainEvent, DealSnapshot, Evidence } from './model.js';

/**
 * The Markdown report of the evidence of one deal: the contracts and their
 * code, the transactions with their links, the rank lines and the
 * settlement of each payment date, the holders, and the checks.
 */
const CLASS_LETTERS = 'ABCDEFGH';

function letter(classIndex: number): string {
  return CLASS_LETTERS[classIndex] ?? String(classIndex);
}

function short(address: string): string {
  return `${address.slice(0, 5)}...${address.slice(-4)}`;
}

export function explorerLink(network: string, hash: string): string {
  return `https://stellar.expert/explorer/${network === 'mainnet' ? 'public' : 'testnet'}/tx/${hash}`;
}

/** The role of an address in the deal, for the signer column. */
export function roleOf(snapshot: DealSnapshot, address: string | null): string {
  if (address === null) return 'not read';
  const { config } = snapshot;
  const names: string[] = [];
  if (address === config.admin) names.push('admin');
  if (address === config.servicer) names.push('servicer');
  if (address === snapshot.reporter) names.push('reporter');
  if (address === config.seller) names.push('seller');
  if (address === snapshot.crank) names.push('crank');
  if (snapshot.holders.some((row) => row.holder === address)) names.push('holder');
  return `${names.length > 0 ? names.join(', ') : 'other'} (${short(address)})`;
}

function itemText(item: OnChainItem): string {
  switch (item.kind) {
    case 'fee':
      return `Fee line ${item.index}`;
    case 'interest':
      return `Interest, Class ${letter(item.class)}`;
    case 'principal':
      return `Principal, Class ${letter(item.class)}`;
    case 'reserveRefill':
      return 'Reserve re-fund';
    case 'residual':
      return 'Residual to the seller';
  }
}

/** What a transaction did, from its events. */
export function stepOf(events: readonly ChainEvent[]): string {
  const first = (type: string): ChainEvent | undefined => events.find((event) => event.type === type);
  const settled = first('period_settled');
  if (settled) return `distribute, period ${String(settled.topics[0])}${first('matured') ? ' (maturity)' : ''}`;
  if (first('deal_closed')) return 'close (closing DvP)';
  const subscribed = first('subscribed');
  if (subscribed) return `subscribe, Class ${letter(Number(subscribed.data[0]))}, ${String(subscribed.data[1])} note(s)`;
  const cancelled = first('sub_cancelled');
  if (cancelled) return `cancel, Class ${letter(Number(cancelled.data[0]))}, ${String(cancelled.data[1])} note(s)`;
  if (first('sub_loan_funded')) return 'fund_sub_loan';
  if (first('sub_loan_refunded')) return 'refund_sub_loan';
  if (first('enforced')) return 'set_enforced';
  if (first('deal_aborted')) return 'abort';
  const eligible = events.filter((event) => event.type === 'eligibility_set');
  if (eligible.length > 0) return `set_eligible, ${eligible.length} holder(s)`;
  const rate = first('rate_set');
  if (rate) return `set_rate, ${String(rate.data[0])} units`;
  const batch = first('batch_done');
  if (batch) {
    const failed = events.filter((event) => event.type === 'push_failed').length;
    return `push_batch, period ${String(batch.topics[0])}, Class ${letter(Number(batch.data[0]))}${failed > 0 ? `, ${failed} push failed` : ''}`;
  }
  if (first('claimed')) return 'claim (paying agent)';
  if (first('owed_claimed')) return 'claim_owed';
  const transfer = first('transfer');
  if (transfer) return `note transfer, ${String(transfer.data[0])} note(s)`;
  return events[0]?.type ?? 'transaction';
}

function table(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

export function renderReport(evidence: Evidence, checks: readonly Check[]): string {
  const { snapshot, network } = evidence;
  const { config } = snapshot;
  const units = (value: bigint): string => formatUnits(value, snapshot.asset.decimals);
  const lines: string[] = [];
  const push = (...text: string[]): void => {
    lines.push(...text);
  };

  push(`### ${evidence.label}`, '');
  push(`Read on ${evidence.collectedAt} (${network}), ledgers ${evidence.fromLedger} to ${evidence.latestLedger}.`, '');
  push(
    ...table(
      ['Contract', 'Id', 'Code (wasm hash)'],
      [
        ['abs-deal', `\`${snapshot.deal}\``, `\`${snapshot.code.deal}\``],
        ['paying-agent', `\`${snapshot.payingAgent}\``, `\`${snapshot.code.agent}\``],
        ...snapshot.notes.map((note, index) => [`note token, Class ${letter(index)}`, `\`${note}\``, `\`${snapshot.code.note}\``]),
        ['rate-oracle', `\`${config.oracle}\``, ''],
        [`asset (${snapshot.asset.symbol})`, `\`${snapshot.asset.contractId}\``, ''],
      ],
    ),
    '',
  );
  push(
    ...table(
      ['Role', 'Address'],
      [
        ['admin (the operator)', `\`${config.admin}\``],
        ['servicer', `\`${config.servicer}\``],
        ['reporter of the oracle', snapshot.reporter === null ? 'not read: fixed rates only' : `\`${snapshot.reporter}\``],
        ['seller', `\`${config.seller}\``],
      ],
    ),
    '',
  );
  push(
    `State: ${snapshot.state}. Reserve ${units(snapshot.reserve)}, carry ${units(snapshot.carry)}, ` +
      `amounts owed ${units(snapshot.owedTotal)}, balance ${units(snapshot.balance)} ${snapshot.asset.symbol}.`,
    '',
  );

  if (evidence.transactions.length > 0) {
    push('#### Transactions', '');
    push(
      ...table(
        ['Step', 'Signer', 'Transaction'],
        evidence.transactions.map((row) => [
          row.step,
          roleOf(snapshot, row.signer),
          `[\`${row.hash.slice(0, 12)}...\`](${explorerLink(network, row.hash)})`,
        ]),
      ),
      '',
    );
  }

  for (const period of periodsOf(evidence)) {
    const settled = period.settled;
    push(`#### Period ${period.period}: ${period.enforced ? 'enforced' : 'normal'} order`, '');
    push(`Transaction [\`${period.txHash.slice(0, 12)}...\`](${explorerLink(network, period.txHash)}).`, '');
    push(
      ...table(
        ['Rank', 'Item', 'Due', 'Paid', 'Dust to the carry'],
        period.lines.map((line) => [`\`${line.rank}\``, itemText(line.item), units(line.due), units(line.paid), units(line.dust)]),
      ),
      '',
    );
    if (period.breached.length > 0) push(`Triggers set in this period: ${period.breached.map((id) => `\`${id}\``).join(', ')}.`, '');
    push(
      ...table(
        ['Collections', 'Reserve in', 'Carry in', 'Drawn', 'Paid out', 'Reserve', 'Carry', 'Owed', 'Balance', 'Surplus'],
        [
          [
            settled.collections,
            settled.reserveIn,
            settled.carryIn,
            settled.drawn,
            settled.paidOut,
            settled.reserve,
            settled.carry,
            settled.owed,
            settled.balance,
            settled.surplus,
          ].map(units),
        ],
      ),
      '',
    );
    push(
      `Conservation: ${units(settled.collections)} + ${units(settled.reserveIn)} + ${units(settled.carryIn)} = ` +
        `${units(settled.paidOut)} + ${units(settled.reserve)} + ${units(settled.carry)}. ` +
        `Balance invariant: ${units(settled.balance)} >= ${units(settled.reserve + settled.carry + settled.owed)}.`,
      '',
    );
  }

  if (snapshot.holders.length > 0) {
    push('#### Holders: cumulative counters of the paying agent', '');
    push(
      ...table(
        ['Class', 'Holder', 'Notes', 'Interest received', 'Principal received', 'Waits in the paying agent'],
        snapshot.holders.map((row) => [
          letter(row.class),
          `\`${row.holder}\``,
          row.notes.toString(),
          units(row.interestPaid),
          units(row.principalPaid),
          units(row.claimableInterest + row.claimablePrincipal),
        ]),
      ),
      '',
    );
  }

  if (evidence.accounts.length > 0) {
    push('#### Operations of the accounts', '');
    push(
      ...table(
        ['Account', 'Operation', 'Result', 'Transaction'],
        evidence.accounts.map((row) => [
          `\`${short(row.account)}\``,
          row.what,
          row.successful ? 'success' : 'failed',
          `[\`${row.hash.slice(0, 12)}...\`](${explorerLink(network, row.hash)})`,
        ]),
      ),
      '',
    );
  }

  push('#### Checks', '');
  push(
    ...table(
      ['Check', 'Result', 'Detail'],
      checks.map((check) => [`${check.id} ${check.title}`, check.status.toUpperCase(), check.detail]),
    ),
    '',
  );
  return `${lines.join('\n')}\n`;
}
