import { Keypair, nativeToScVal, type Transaction } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { NOT_A_TRANSACTION, OTHER_ACTIVITY, createChecker } from '../src/checker/checker.js';
import {
  DecisionRefusedError,
  type ApprovalsPort,
  type DecisionValue,
  type InvestorWallet,
  type PendingApproval,
} from '../src/checker/port.js';
import { GENERAL_DENIAL } from '../src/policy/evaluate.js';
import {
  DEAL,
  NOTE_TOKEN,
  NOW,
  POLICY,
  addressArg,
  buildTx,
  claimOp,
  contractCall,
  silentLogger,
  subscribeOp,
} from './helpers.js';

const investor: InvestorWallet = { walletId: 'wa-investor', keyId: 'key-investor', address: Keypair.random().publicKey() };
const operator = { walletId: 'wa-servicer', keyId: 'key-servicer', address: Keypair.random().publicKey() };

class FakeApprovals implements ApprovalsPort {
  pending: PendingApproval[] = [];
  readonly decisions: { approvalId: string; value: DecisionValue; reason: string }[] = [];
  walletReads = 0;
  approvalReads = 0;
  refuse = false;
  hold: Promise<void> | null = null;

  async listInvestorWallets(): Promise<InvestorWallet[]> {
    this.walletReads += 1;
    return [investor];
  }

  async listPendingApprovals(): Promise<PendingApproval[]> {
    this.approvalReads += 1;
    if (this.hold) await this.hold;
    return this.pending.map((approval) => ({ ...approval }));
  }

  async createDecision(input: { approvalId: string; value: DecisionValue; reason: string }): Promise<void> {
    if (this.refuse) throw new DecisionRefusedError('Dfns refused the decision (HTTP 403).');
    this.decisions.push(input);
  }
}

function signatureApproval(id: string, keyId: string, transaction: Transaction): PendingApproval {
  return {
    id,
    activityKind: 'Wallets:Sign',
    decisionCount: 0,
    signature: {
      keyId,
      requestKind: 'Transaction',
      network: 'StellarTestnet',
      transaction: `0x${transaction.toEnvelope().toXDR('hex')}`,
    },
  };
}

let approvals: FakeApprovals;
let checker: { tick(): Promise<void> };

beforeEach(() => {
  approvals = new FakeApprovals();
  silentLogger.lines.length = 0;
  checker = createChecker({ approvals, policy: POLICY, now: () => NOW, log: silentLogger });
});

describe('checker votes', () => {
  it('approves an allowlisted subscribe below the threshold, with a reason that names the action', async () => {
    approvals.pending = [signatureApproval('ap-1', investor.keyId, buildTx(investor.address, [subscribeOp(investor.address, 2n)]))];
    await checker.tick();
    expect(approvals.decisions).toEqual([
      {
        approvalId: 'ap-1',
        value: 'Approved',
        reason: `Subscribe 2 notes of class 0 (200 EURC) in ${DEAL.name}.`,
      },
    ]);
  });

  it('approves a claim', async () => {
    approvals.pending = [signatureApproval('ap-1', investor.keyId, buildTx(investor.address, [claimOp(investor.address)]))];
    await checker.tick();
    expect(approvals.decisions[0]?.value).toBe('Approved');
  });

  it('denies a call outside the allowlist, with the readable reason', async () => {
    const args = [addressArg(investor.address), addressArg(operator.address), nativeToScVal(1n, { type: 'i128' })];
    const transaction = buildTx(investor.address, [contractCall(NOTE_TOKEN, 'transfer', args)]);
    approvals.pending = [signatureApproval('ap-2', investor.keyId, transaction)];
    await checker.tick();
    expect(approvals.decisions).toEqual([{ approvalId: 'ap-2', value: 'Denied', reason: GENERAL_DENIAL }]);
  });

  it('denies a transaction whose source is not the wallet of the key', async () => {
    const transaction = buildTx(operator.address, [claimOp(operator.address)]);
    approvals.pending = [signatureApproval('ap-3', investor.keyId, transaction)];
    await checker.tick();
    expect(approvals.decisions).toEqual([
      { approvalId: 'ap-3', value: 'Denied', reason: 'The transaction source must be your wallet.' },
    ]);
  });

  it('does not vote above the threshold, and logs it once', async () => {
    approvals.pending = [signatureApproval('ap-4', investor.keyId, buildTx(investor.address, [subscribeOp(investor.address, 3n)]))];
    await checker.tick();
    await checker.tick();
    expect(approvals.decisions).toEqual([]);
    expect(silentLogger.lines.filter((line) => line.includes('ap-4'))).toHaveLength(1);
  });

  it('denies a hash or message signature on an investor wallet', async () => {
    approvals.pending = [
      { id: 'ap-5', activityKind: 'Wallets:Sign', decisionCount: 0, signature: { keyId: investor.keyId, requestKind: 'Hash' } },
    ];
    await checker.tick();
    expect(approvals.decisions).toEqual([{ approvalId: 'ap-5', value: 'Denied', reason: NOT_A_TRANSACTION }]);
  });

  it('denies a transfer request on an investor wallet', async () => {
    approvals.pending = [{ id: 'ap-6', activityKind: 'Wallets:Sign', decisionCount: 0, walletId: investor.walletId }];
    await checker.tick();
    expect(approvals.decisions).toEqual([{ approvalId: 'ap-6', value: 'Denied', reason: OTHER_ACTIVITY }]);
  });

  it('denies an envelope that cannot be decoded', async () => {
    approvals.pending = [
      {
        id: 'ap-7',
        activityKind: 'Wallets:Sign',
        decisionCount: 0,
        signature: { keyId: investor.keyId, requestKind: 'Transaction', network: 'StellarTestnet', transaction: '0xzz' },
      },
    ];
    await checker.tick();
    expect(approvals.decisions[0]).toMatchObject({ value: 'Denied', reason: 'The transaction cannot be decoded.' });
  });
});

describe('checker scope', () => {
  it('never votes on a wallet that is not tagged cara7:investor', async () => {
    const operatorTx = buildTx(operator.address, [claimOp(operator.address)]);
    approvals.pending = [
      signatureApproval('ap-op-1', operator.keyId, operatorTx),
      { id: 'ap-op-2', activityKind: 'Wallets:Sign', decisionCount: 0, walletId: operator.walletId },
    ];
    await checker.tick();
    expect(approvals.decisions).toEqual([]);
  });

  it('ignores other activity kinds and approvals that already have a decision', async () => {
    const transaction = buildTx(investor.address, [claimOp(investor.address)]);
    approvals.pending = [
      { id: 'ap-policy', activityKind: 'Policies:Modify', decisionCount: 0 },
      { ...signatureApproval('ap-voted', investor.keyId, transaction), decisionCount: 1 },
    ];
    await checker.tick();
    expect(approvals.decisions).toEqual([]);
  });

  it('does not vote twice on the same approval', async () => {
    approvals.pending = [signatureApproval('ap-1', investor.keyId, buildTx(investor.address, [claimOp(investor.address)]))];
    await checker.tick();
    await checker.tick();
    expect(approvals.decisions).toHaveLength(1);
  });

  it('does not try again after Dfns refuses the decision', async () => {
    approvals.refuse = true;
    approvals.pending = [signatureApproval('ap-1', investor.keyId, buildTx(investor.address, [claimOp(investor.address)]))];
    await checker.tick();
    approvals.refuse = false;
    await checker.tick();
    expect(approvals.decisions).toEqual([]);
  });

  it('skips a tick while the previous tick still runs', async () => {
    let release: () => void = () => {};
    approvals.hold = new Promise((resolve) => {
      release = resolve;
    });
    const first = checker.tick();
    await checker.tick();
    release();
    await first;
    expect(approvals.approvalReads).toBe(1);
  });

  it('caches the investor wallet list between ticks', async () => {
    approvals.pending = [signatureApproval('ap-1', investor.keyId, buildTx(investor.address, [claimOp(investor.address)]))];
    await checker.tick();
    approvals.pending = [signatureApproval('ap-2', investor.keyId, buildTx(investor.address, [claimOp(investor.address)]))];
    await checker.tick();
    expect(approvals.walletReads).toBe(1);
    expect(approvals.decisions).toHaveLength(2);
  });
});
