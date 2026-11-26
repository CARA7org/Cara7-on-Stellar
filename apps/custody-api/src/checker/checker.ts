import { passphraseForDfnsNetwork } from '../custody/network.js';
import type { AppLogger } from '../deps.js';
import { evaluateRequest, type Evaluation } from '../policy/evaluate.js';
import type { Policy } from '../policy/policy.js';
import { decodeEnvelope, hexToBase64 } from '../signing/envelope.js';
import {
  DecisionRefusedError,
  type ApprovalsPort,
  type DecisionValue,
  type InvestorWallet,
  type PendingApproval,
  type PendingSignature,
} from './port.js';

export const NOT_A_TRANSACTION = 'This wallet may only sign a Stellar transaction.';
export const OTHER_ACTIVITY = 'This wallet may only sign transactions that CARA7 prepares.';
const MAX_REASON_LENGTH = 250;

export type CheckerOptions = {
  approvals: ApprovalsPort;
  policy: Policy;
  now: () => Date;
  log: AppLogger;
  /// The wallet list is read again after this delay.
  walletCacheMs?: number;
  /// An unknown key reads the wallet list again, but not more often than this.
  missRefreshMs?: number;
};

/// Maps a Dfns key id or wallet id to an investor wallet. It reads the list
/// of wallets tagged cara7:investor through the Dfns API and caches it.
export class WalletDirectory {
  private byKey = new Map<string, InvestorWallet>();
  private byWallet = new Map<string, InvestorWallet>();
  private loadedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly approvals: ApprovalsPort,
    private readonly now: () => Date,
    private readonly cacheMs: number,
    private readonly missRefreshMs: number,
  ) {}

  async forKey(keyId: string): Promise<InvestorWallet | undefined> {
    return this.find((directory) => directory.byKey.get(keyId));
  }

  async forWallet(walletId: string): Promise<InvestorWallet | undefined> {
    return this.find((directory) => directory.byWallet.get(walletId));
  }

  private async find(
    lookup: (directory: WalletDirectory) => InvestorWallet | undefined,
  ): Promise<InvestorWallet | undefined> {
    if (this.age() > this.cacheMs) await this.reload();
    const found = lookup(this);
    if (found || this.age() < this.missRefreshMs) return found;
    await this.reload();
    return lookup(this);
  }

  private age(): number {
    return this.now().getTime() - this.loadedAt;
  }

  private async reload(): Promise<void> {
    const wallets = await this.approvals.listInvestorWallets();
    this.byKey = new Map(wallets.map((wallet) => [wallet.keyId, wallet]));
    this.byWallet = new Map(wallets.map((wallet) => [wallet.walletId, wallet]));
    this.loadedAt = this.now().getTime();
  }
}

/// Decodes the transaction of a signature request and applies the policy.
export function judgeSignature(
  signature: PendingSignature,
  wallet: InvestorWallet,
  policy: Policy,
  now: Date,
): Evaluation {
  if (signature.requestKind !== 'Transaction' || !signature.transaction) {
    return { verdict: 'deny', reason: NOT_A_TRANSACTION };
  }
  const passphrase = signature.network
    ? passphraseForDfnsNetwork(signature.network)
    : policy.networkPassphrase;
  if (passphrase === null) return { verdict: 'deny', reason: 'The request is for an unknown network.' };
  const base64 = hexToBase64(signature.transaction);
  const transaction = base64 === null ? null : decodeEnvelope(base64, passphrase);
  if (transaction === null) return { verdict: 'deny', reason: 'The transaction cannot be decoded.' };
  return evaluateRequest(transaction, { walletAddress: wallet.address, policy, now });
}

/// One checker cycle per tick. Overlapping ticks are skipped.
export function createChecker(options: CheckerOptions): { tick(): Promise<void> } {
  const checker = new Checker(options);
  return { tick: () => checker.tick() };
}

class Checker {
  private readonly directory: WalletDirectory;
  private readonly decided = new Set<string>();
  private readonly abstained = new Set<string>();
  private running = false;

  constructor(private readonly options: CheckerOptions) {
    this.directory = new WalletDirectory(
      options.approvals,
      options.now,
      options.walletCacheMs ?? 60_000,
      options.missRefreshMs ?? 10_000,
    );
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { approvals, log } = this.options;
    try {
      const pending = await approvals.listPendingApprovals();
      for (const approval of pending) {
        try {
          await this.handle(approval);
        } catch (error) {
          log.error(`[checker] ${approval.id}: the check failed`, error);
        }
      }
      forgetResolved(pending, this.decided, this.abstained);
    } catch (error) {
      log.error('[checker] the cycle failed', error);
    } finally {
      this.running = false;
    }
  }

  private async handle(approval: PendingApproval): Promise<void> {
    if (this.decided.has(approval.id) || this.abstained.has(approval.id)) return;
    if (approval.activityKind !== 'Wallets:Sign' || approval.decisionCount > 0) return;
    const evaluation = await this.judge(approval);
    if (evaluation === null) return;
    if (evaluation.verdict === 'abstain') {
      this.abstained.add(approval.id);
      this.options.log.info(`[checker] ${approval.id}: no vote, a person decides. ${evaluation.reason}`);
      return;
    }
    await this.vote(approval.id, evaluation.verdict === 'approve' ? 'Approved' : 'Denied', evaluation.reason);
  }

  /// Gives the evaluation, or null when the approval is not for an investor wallet.
  private async judge(approval: PendingApproval): Promise<Evaluation | null> {
    const { policy, now } = this.options;
    if (approval.signature) {
      const wallet = await this.directory.forKey(approval.signature.keyId);
      return wallet ? judgeSignature(approval.signature, wallet, policy, now()) : null;
    }
    if (approval.walletId) {
      const wallet = await this.directory.forWallet(approval.walletId);
      return wallet ? { verdict: 'deny', reason: OTHER_ACTIVITY } : null;
    }
    return null;
  }

  private async vote(approvalId: string, value: DecisionValue, fullReason: string): Promise<void> {
    const reason = fullReason.slice(0, MAX_REASON_LENGTH);
    try {
      await this.options.approvals.createDecision({ approvalId, value, reason });
      this.decided.add(approvalId);
      this.options.log.info(`[checker] ${approvalId}: ${value}. ${reason}`);
    } catch (error) {
      if (error instanceof DecisionRefusedError) this.decided.add(approvalId);
      this.options.log.error(`[checker] ${approvalId}: the ${value} vote failed`, error);
    }
  }
}

/// An approval that is not pending any more does not come back. Its id can go.
function forgetResolved(pending: PendingApproval[], ...sets: Set<string>[]): void {
  const pendingIds = new Set(pending.map((approval) => approval.id));
  for (const set of sets) {
    for (const id of set) if (!pendingIds.has(id)) set.delete(id);
  }
}
