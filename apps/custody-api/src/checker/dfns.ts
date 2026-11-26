import { DfnsError, type DfnsApiClient } from '@dfns/sdk';
import { INVESTOR_TAG } from '../custody/port.js';
import {
  DecisionRefusedError,
  type ApprovalsPort,
  type InvestorWallet,
  type PendingApproval,
} from './port.js';

type ApprovalItem = Awaited<ReturnType<DfnsApiClient['policies']['listApprovals']>>['items'][number];

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/// The Dfns adapter of the checker. It uses the checker service account.
/// It needs Wallets:Read, Policies:Approvals:Read and Policies:Approvals:Approve.
export function createDfnsApprovals(client: DfnsApiClient): ApprovalsPort {
  return {
    async listInvestorWallets() {
      const wallets: InvestorWallet[] = [];
      let paginationToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await client.wallets.listWallets({
          query: { limit: PAGE_SIZE, paginationToken },
        });
        for (const wallet of response.items) {
          if (!wallet.tags.includes(INVESTOR_TAG) || !wallet.address) continue;
          if (wallet.status === 'Archived') continue;
          wallets.push({ walletId: wallet.id, keyId: wallet.signingKey.id, address: wallet.address });
        }
        paginationToken = response.nextPageToken;
        if (!paginationToken) break;
      }
      return wallets;
    },
    async listPendingApprovals() {
      const approvals: PendingApproval[] = [];
      let paginationToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await client.policies.listApprovals({
          query: { status: 'Pending', limit: String(PAGE_SIZE), paginationToken },
        });
        approvals.push(...response.items.map(toPendingApproval));
        paginationToken = response.nextPageToken;
        if (!paginationToken) break;
      }
      return approvals;
    },
    async createDecision({ approvalId, value, reason }) {
      try {
        await client.policies.createApprovalDecision({ approvalId, body: { value, reason } });
      } catch (error) {
        if (error instanceof DfnsError && error.httpStatus >= 400 && error.httpStatus < 500) {
          throw new DecisionRefusedError(`Dfns refused the decision (HTTP ${error.httpStatus}): ${error.message}`);
        }
        throw error;
      }
    },
  };
}

export function toPendingApproval(item: ApprovalItem): PendingApproval {
  const base = { id: item.id, activityKind: item.activity.kind, decisionCount: item.decisions.length };
  const activity = item.activity;
  if (activity.kind !== 'Wallets:Sign') return base;
  const request = activity.signatureRequest;
  if (request) {
    const body = request.requestBody;
    const transaction =
      body.kind === 'Transaction' && typeof body.transaction === 'string' ? body.transaction : undefined;
    const network = body.network ?? request.network;
    return {
      ...base,
      signature: {
        keyId: request.keyId,
        requestKind: body.kind,
        ...(network ? { network } : {}),
        ...(transaction ? { transaction } : {}),
      },
    };
  }
  const walletId =
    activity.transferRequest?.walletId ??
    activity.transactionRequest?.walletId ??
    activity.swapRequest?.walletId;
  return walletId ? { ...base, walletId } : base;
}
