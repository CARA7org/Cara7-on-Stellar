import {
  Address,
  Asset,
  FeeBumpTransaction,
  scValToBigInt,
  type Operation,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';
import type { RequestSummary } from '../types.js';
import { formatUnits, toBaseUnits } from './amounts.js';
import type { DealEntry, Policy } from './policy.js';

// The allowlist for investor wallets. The custody-api guard and the checker
// both call evaluateRequest. The rules run in a fixed order. The first rule
// that fails gives `deny` with a readable reason.

export const GENERAL_DENIAL = 'This wallet may only subscribe, cancel, claim or hold EURC.';

export type Verdict = 'approve' | 'abstain' | 'deny';

export type Evaluation =
  | { verdict: 'approve' | 'abstain'; reason: string; summary: RequestSummary }
  | { verdict: 'deny'; reason: string };

export type EvaluationContext = {
  walletAddress: string;
  policy: Policy;
  now: Date;
};

type ContractCall = {
  contractId: string;
  functionName: string;
  args: xdr.ScVal[];
  invocation: xdr.InvokeContractArgs;
};

type SubscriptionArgs = { investor: string; classIndex: number; notes: bigint };

export function evaluateRequest(
  transaction: Transaction | FeeBumpTransaction,
  context: EvaluationContext,
): Evaluation {
  if (transaction instanceof FeeBumpTransaction) {
    return deny('A fee bump transaction is not allowed.');
  }
  const denial = checkTransaction(transaction, context);
  if (denial !== null) return deny(denial);
  const operation = transaction.operations[0];
  if (operation?.type === 'invokeHostFunction') return evaluateInvocation(operation, context);
  if (operation?.type === 'changeTrust') return evaluateChangeTrust(operation, context.policy);
  return deny(GENERAL_DENIAL);
}

/// Rules 1 to 5: network, source, one operation, fee and time bounds.
function checkTransaction(transaction: Transaction, context: EvaluationContext): string | null {
  const { walletAddress, policy } = context;
  if (transaction.networkPassphrase !== policy.networkPassphrase) {
    return 'The transaction is for another Stellar network.';
  }
  if (transaction.source !== walletAddress) return 'The transaction source must be your wallet.';
  if (transaction.operations.length !== 1) {
    return 'The transaction must contain exactly one operation.';
  }
  const operationSource = transaction.operations[0]?.source;
  if (operationSource !== undefined && operationSource !== walletAddress) {
    return 'The operation source must be your wallet.';
  }
  if (BigInt(transaction.fee) > BigInt(policy.maxFeeStroops)) {
    return `The transaction fee is above the limit of ${policy.maxFeeStroops} stroops.`;
  }
  return checkTimeBounds(transaction, context);
}

function checkTimeBounds(transaction: Transaction, { policy, now }: EvaluationContext): string | null {
  const maxTime = BigInt(transaction.timeBounds?.maxTime ?? '0');
  if (maxTime === 0n) return 'The transaction must have an expiry time.';
  const latest = BigInt(Math.floor(now.getTime() / 1000)) + BigInt(policy.maxValiditySeconds);
  if (maxTime > latest) {
    return `The transaction must expire within ${policy.maxValiditySeconds} seconds.`;
  }
  return null;
}

/// Rule 6 for a contract call: subscribe, cancel or claim on a listed contract.
function evaluateInvocation(
  operation: Operation.InvokeHostFunction,
  context: EvaluationContext,
): Evaluation {
  const call = readContractCall(operation.func);
  if (call === null) return deny(GENERAL_DENIAL);
  const { deals } = context.policy;
  const subscriptionDeal = deals.find((deal) => deal.dealContractId === call.contractId);
  const claimDeal = deals.find((deal) => deal.payingAgentContractId === call.contractId);
  let evaluation: Evaluation;
  if (subscriptionDeal && (call.functionName === 'subscribe' || call.functionName === 'cancel')) {
    evaluation = evaluateSubscription(call, subscriptionDeal, context);
  } else if (claimDeal && call.functionName === 'claim') {
    evaluation = evaluateClaim(call, claimDeal, context.walletAddress);
  } else {
    return deny(GENERAL_DENIAL);
  }
  if (evaluation.verdict === 'deny') return evaluation;
  const authDenial = checkAuthorizations(operation.auth ?? [], call.invocation);
  return authDenial === null ? evaluation : deny(authDenial);
}

function evaluateSubscription(
  call: ContractCall,
  deal: DealEntry,
  { walletAddress, policy }: EvaluationContext,
): Evaluation {
  const kind = call.functionName === 'subscribe' ? 'subscribe' : 'cancel';
  const args = readSubscriptionArgs(call.args);
  if (args === null) return deny(`The ${kind} call must have the arguments (investor, class, notes).`);
  if (args.investor !== walletAddress) return deny('The investor argument must be your wallet.');
  if (args.notes <= 0n) return deny('The number of notes must be above zero.');
  const amount = args.notes * BigInt(deal.noteDenomination);
  const amountEurc = formatUnits(amount, policy.eurc.decimals);
  const summary: RequestSummary = {
    kind,
    contractId: deal.dealContractId,
    classIndex: args.classIndex,
    notes: args.notes.toString(),
    amountEurc,
  };
  const verb = kind === 'subscribe' ? 'Subscribe' : 'Cancel';
  const noteWord = args.notes === 1n ? 'note' : 'notes';
  const action = `${verb} ${args.notes} ${noteWord} of class ${args.classIndex} (${amountEurc} EURC) in ${deal.name}.`;
  const threshold = toBaseUnits(policy.thresholdEurc, policy.eurc.decimals);
  if (kind === 'subscribe' && amount > threshold) {
    const reason = `${action} The amount is above the ${policy.thresholdEurc} EURC threshold, so a person must approve it.`;
    return { verdict: 'abstain', reason, summary };
  }
  return { verdict: 'approve', reason: action, summary };
}

function evaluateClaim(call: ContractCall, deal: DealEntry, walletAddress: string): Evaluation {
  const [holderArg] = call.args;
  const holder = call.args.length === 1 && holderArg ? readAddress(holderArg) : null;
  if (holder === null) return deny('The claim call must have one argument: your wallet.');
  if (holder !== walletAddress) return deny('The holder argument must be your wallet.');
  const summary: RequestSummary = { kind: 'claim', contractId: deal.payingAgentContractId };
  return { verdict: 'approve', reason: `Claim the payments of ${deal.name}.`, summary };
}

/// Every auth entry uses the source account credentials, and its root
/// invocation is the same contract call as the operation.
function checkAuthorizations(
  entries: xdr.SorobanAuthorizationEntry[],
  invocation: xdr.InvokeContractArgs,
): string | null {
  const expected = invocation.toXDR('base64');
  for (const entry of entries) {
    if (entry.credentials().switch().name !== 'sorobanCredentialsSourceAccount') {
      return 'Every authorization must use the transaction source account.';
    }
    const root = entry.rootInvocation().function();
    if (
      root.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn' ||
      root.contractFn().toXDR('base64') !== expected
    ) {
      return 'The authorization does not match the contract call.';
    }
  }
  return null;
}

/// Rule 6 for a classic operation: only a trustline to the policy EURC.
function evaluateChangeTrust(operation: Operation.ChangeTrust, policy: Policy): Evaluation {
  const line = operation.line;
  const isEurc =
    line instanceof Asset &&
    !line.isNative() &&
    line.getCode() === policy.eurc.code &&
    line.getIssuer() === policy.eurc.issuer;
  if (!isEurc) return deny(GENERAL_DENIAL);
  const removes = /^0+(\.0+)?$/.test(operation.limit);
  const reason = removes
    ? 'Remove the EURC trustline.'
    : `Hold EURC with a trustline limit of ${operation.limit}.`;
  return { verdict: 'approve', reason, summary: { kind: 'change_trust', limit: operation.limit } };
}

function readContractCall(func: xdr.HostFunction): ContractCall | null {
  if (func.switch().name !== 'hostFunctionTypeInvokeContract') return null;
  const invocation = func.invokeContract();
  const contractId = scAddressToString(invocation.contractAddress());
  if (contractId === null) return null;
  return {
    contractId,
    functionName: invocation.functionName().toString(),
    args: invocation.args(),
    invocation,
  };
}

function readSubscriptionArgs(args: xdr.ScVal[]): SubscriptionArgs | null {
  if (args.length !== 3) return null;
  const [investorArg, classArg, notesArg] = args;
  if (!investorArg || !classArg || !notesArg) return null;
  const investor = readAddress(investorArg);
  if (investor === null) return null;
  if (classArg.switch().name !== 'scvU32' || notesArg.switch().name !== 'scvI128') return null;
  return { investor, classIndex: classArg.u32(), notes: scValToBigInt(notesArg) };
}

function readAddress(value: xdr.ScVal): string | null {
  if (value.switch().name !== 'scvAddress') return null;
  return scAddressToString(value.address());
}

function scAddressToString(address: xdr.ScAddress): string | null {
  try {
    return Address.fromScAddress(address).toString();
  } catch {
    return null;
  }
}

function deny(reason: string): Evaluation {
  return { verdict: 'deny', reason };
}

/// The checker verdict that the custody-api reports to the front.
export function decisionFor(verdict: 'approve' | 'abstain'): 'auto' | 'needs_approval' {
  return verdict === 'approve' ? 'auto' : 'needs_approval';
}
