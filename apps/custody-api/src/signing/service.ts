import { randomUUID } from 'node:crypto';
import type { SignatureState } from '../custody/port.js';
import type { AppDependencies } from '../deps.js';
import { HttpError, badRequest, notFound } from '../errors.js';
import { decisionFor, evaluateRequest } from '../policy/evaluate.js';
import type { InvestorRecord, SigningRequestRecord } from '../store/port.js';
import type { SignResult, SignStatus } from '../types.js';
import { checkSignedEnvelope, decodeEnvelope } from './envelope.js';

export const PENDING_EXISTS = 'An earlier action is still waiting for approval.';
export const DEFAULT_REJECTED = 'The approval policy rejected this request.';
export const DEFAULT_FAILED = 'The custody provider could not sign this request.';

type Outcome = { status: SignStatus; reason?: string; signedTxXdr?: string };

/// POST /sign: guard, one pending request per investor, then Dfns.
export async function startSigning(
  deps: AppDependencies,
  investor: InvestorRecord,
  body: { transactionXdr: string; networkPassphrase: string },
): Promise<SignResult> {
  const transaction = decodeEnvelope(body.transactionXdr, body.networkPassphrase);
  if (transaction === null) throw badRequest('The transaction XDR cannot be decoded.');
  const evaluation = evaluateRequest(transaction, {
    walletAddress: investor.address,
    policy: deps.policy,
    now: deps.now(),
  });
  if (evaluation.verdict === 'deny') throw new HttpError(422, 'not_allowed', evaluation.reason);
  await refuseWhilePending(deps, investor);

  const requestId = randomUUID();
  const preparedHash = transaction.hash().toString('hex');
  const state = await deps.custody.generateSignature({
    keyId: investor.keyId,
    transactionHex: `0x${transaction.toEnvelope().toXDR('hex')}`,
    externalId: requestId,
  });
  const outcome = resolveOutcome(deps, state, preparedHash, investor.address);
  const record = await deps.store.createSigningRequest({
    id: requestId,
    investorId: investor.id,
    dfnsSignatureId: state.signatureId,
    keyId: investor.keyId,
    preparedHash,
    status: outcome.status,
    approvalId: state.approvalId ?? null,
    reason: outcome.reason ?? null,
    decision: decisionFor(evaluation.verdict),
    summary: evaluation.summary,
  });
  return toSignResult(record, outcome.signedTxXdr);
}

/// GET /sign/:requestId: only the owner sees the request.
export async function refreshSigning(
  deps: AppDependencies,
  investor: InvestorRecord,
  requestId: string,
): Promise<SignResult> {
  const record = await deps.store.findSigningRequest(requestId);
  if (record === null || record.investorId !== investor.id) {
    throw notFound('This signature request does not exist.');
  }
  if (record.status === 'rejected' || record.status === 'failed') return toSignResult(record);
  const { updated, signedTxXdr } = await refreshRecord(deps, record, investor.address);
  return toSignResult(updated, signedTxXdr);
}

async function refuseWhilePending(deps: AppDependencies, investor: InvestorRecord): Promise<void> {
  const pending = await deps.store.findPendingSigningRequests(investor.id);
  for (const record of pending) {
    const { updated } = await refreshRecord(deps, record, investor.address);
    if (updated.status === 'pending') throw new HttpError(409, 'pending_exists', PENDING_EXISTS);
  }
}

async function refreshRecord(
  deps: AppDependencies,
  record: SigningRequestRecord,
  walletAddress: string,
): Promise<{ updated: SigningRequestRecord; signedTxXdr?: string }> {
  const state = await deps.custody.getSignature({
    keyId: record.keyId,
    signatureId: record.dfnsSignatureId,
  });
  const outcome = resolveOutcome(deps, state, record.preparedHash, walletAddress);
  const approvalId = state.approvalId ?? record.approvalId;
  const reason = outcome.reason ?? null;
  const changed =
    outcome.status !== record.status || approvalId !== record.approvalId || reason !== record.reason;
  const updated = changed
    ? await deps.store.updateSigningRequest(record.id, { status: outcome.status, approvalId, reason })
    : record;
  return outcome.signedTxXdr === undefined ? { updated } : { updated, signedTxXdr: outcome.signedTxXdr };
}

/// Maps the Dfns status to the SignResult status. A signed envelope must
/// keep the prepared hash.
function resolveOutcome(
  deps: AppDependencies,
  state: SignatureState,
  preparedHash: string,
  walletAddress: string,
): Outcome {
  switch (state.status) {
    case 'Pending':
    case 'Executing':
      return { status: 'pending' };
    case 'Rejected':
      return { status: 'rejected', reason: state.reason ?? DEFAULT_REJECTED };
    case 'Failed':
      return { status: 'failed', reason: state.reason ?? DEFAULT_FAILED };
    case 'Signed':
    case 'Confirmed': {
      const check = checkSignedEnvelope({
        signedData: state.signedData,
        preparedHash,
        walletAddress,
        networkPassphrase: deps.policy.networkPassphrase,
      });
      return check.ok
        ? { status: 'signed', signedTxXdr: check.signedTxXdr }
        : { status: 'failed', reason: check.reason };
    }
  }
}

function toSignResult(record: SigningRequestRecord, signedTxXdr?: string): SignResult {
  const result: SignResult = {
    requestId: record.id,
    status: record.status,
    decision: record.decision,
    summary: record.summary,
  };
  if (record.status === 'signed' && signedTxXdr !== undefined) result.signedTxXdr = signedTxXdr;
  if (record.approvalId !== null) result.approvalId = record.approvalId;
  if (record.reason !== null) result.reason = record.reason;
  return result;
}
