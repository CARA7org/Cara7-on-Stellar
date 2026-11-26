import {
  Asset,
  Keypair,
  Networks,
  Operation,
  TimeoutInfinite,
  TransactionBuilder,
  Account,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { GENERAL_DENIAL, evaluateRequest, type Evaluation } from '../src/policy/evaluate.js';
import type { Policy } from '../src/policy/policy.js';
import {
  DEAL,
  NOTE_TOKEN,
  NOW,
  NOW_SECONDS,
  OTHER_ISSUER,
  POLICY,
  POLICY_200,
  SERIES_2,
  addressArg,
  addressAuth,
  buildTx,
  cancelOp,
  changeTrustOp,
  claimOp,
  contractCall,
  eurc,
  sourceAuth,
  subscribeOp,
  subscriptionArgs,
} from './helpers.js';

const wallet = Keypair.random().publicKey();
const stranger = Keypair.random().publicKey();

function evaluate(
  transaction: Parameters<typeof evaluateRequest>[0],
  policy: Policy = POLICY,
): Evaluation {
  return evaluateRequest(transaction, { walletAddress: wallet, policy, now: NOW });
}

describe('evaluateRequest: allowed calls', () => {
  it('approves a subscribe below the threshold and describes it', () => {
    const result = evaluate(buildTx(wallet, [subscribeOp(wallet, 2n)]));
    expect(result).toEqual({
      verdict: 'approve',
      reason: `Subscribe 2 notes of class 0 (200 EURC) in ${DEAL.name}.`,
      summary: {
        kind: 'subscribe',
        contractId: DEAL.dealContractId,
        classIndex: 0,
        notes: '2',
        amountEurc: '200',
      },
    });
  });

  it('approves a subscribe exactly at the threshold', () => {
    const result = evaluate(buildTx(wallet, [subscribeOp(wallet, 2n)]), POLICY_200);
    expect(result.verdict).toBe('approve');
  });

  it('abstains on a subscribe above the threshold, so that a person decides', () => {
    const result = evaluate(buildTx(wallet, [subscribeOp(wallet, 3n)]), POLICY_200);
    expect(result.verdict).toBe('abstain');
    expect(result.reason).toContain('above the 200 EURC threshold');
    expect(result.verdict !== 'deny' && result.summary.amountEurc).toBe('300');
  });

  it('abstains above the threshold of the committed policy (250 EURC)', () => {
    expect(evaluate(buildTx(wallet, [subscribeOp(wallet, 3n)])).verdict).toBe('abstain');
  });

  it('approves a subscribe on the second listed deal', () => {
    const result = evaluate(
      buildTx(wallet, [subscribeOp(wallet, 1n, { contract: SERIES_2.dealContractId, classIndex: 2 })]),
    );
    expect(result.verdict).toBe('approve');
    expect(result.verdict !== 'deny' && result.summary).toMatchObject({
      contractId: SERIES_2.dealContractId,
      classIndex: 2,
      notes: '1',
      amountEurc: '100',
    });
    expect(result.reason).toBe(`Subscribe 1 note of class 2 (100 EURC) in ${SERIES_2.name}.`);
  });

  it('approves a cancel at any amount', () => {
    const result = evaluate(buildTx(wallet, [cancelOp(wallet, 50n)]));
    expect(result.verdict).toBe('approve');
    expect(result.verdict !== 'deny' && result.summary.kind).toBe('cancel');
  });

  it('approves a claim on a listed paying agent', () => {
    const result = evaluate(buildTx(wallet, [claimOp(wallet)]));
    expect(result).toEqual({
      verdict: 'approve',
      reason: `Claim the payments of ${DEAL.name}.`,
      summary: { kind: 'claim', contractId: DEAL.payingAgentContractId },
    });
  });

  it('approves a call without auth entries', () => {
    expect(evaluate(buildTx(wallet, [subscribeOp(wallet, 1n, { auth: 'none' })])).verdict).toBe('approve');
  });

  it('approves an operation source equal to the wallet', () => {
    expect(evaluate(buildTx(wallet, [claimOp(wallet, { source: wallet })])).verdict).toBe('approve');
  });

  it('approves a ChangeTrust on EURC with a limit', () => {
    const result = evaluate(buildTx(wallet, [changeTrustOp(eurc(), '1000')]));
    expect(result.verdict).toBe('approve');
    expect(result.verdict !== 'deny' && result.summary).toEqual({ kind: 'change_trust', limit: '1000.0000000' });
  });

  it('approves a ChangeTrust on EURC with limit 0 (removes the trustline)', () => {
    const result = evaluate(buildTx(wallet, [changeTrustOp(eurc(), '0')]));
    expect(result.verdict).toBe('approve');
    expect(result.reason).toBe('Remove the EURC trustline.');
  });

  it('accepts a maxTime exactly at now + maxValiditySeconds', () => {
    const maxTime = NOW_SECONDS + POLICY.maxValiditySeconds;
    expect(evaluate(buildTx(wallet, [claimOp(wallet)], { maxTime })).verdict).toBe('approve');
  });
});

describe('evaluateRequest: envelope rules', () => {
  it('denies a fee bump envelope', () => {
    const inner = buildTx(wallet, [claimOp(wallet)]);
    const bump = TransactionBuilder.buildFeeBumpTransaction(Keypair.random(), '200000', inner, Networks.TESTNET);
    expect(evaluate(bump)).toEqual({ verdict: 'deny', reason: 'A fee bump transaction is not allowed.' });
  });

  it('denies a transaction for another network', () => {
    const result = evaluate(buildTx(wallet, [claimOp(wallet)], { networkPassphrase: Networks.PUBLIC }));
    expect(result).toEqual({ verdict: 'deny', reason: 'The transaction is for another Stellar network.' });
  });

  it('denies a transaction with another source', () => {
    const result = evaluate(buildTx(wallet, [claimOp(wallet)], { source: stranger }));
    expect(result).toEqual({ verdict: 'deny', reason: 'The transaction source must be your wallet.' });
  });

  it('denies two operations', () => {
    const result = evaluate(buildTx(wallet, [claimOp(wallet), changeTrustOp(eurc())]));
    expect(result).toEqual({ verdict: 'deny', reason: 'The transaction must contain exactly one operation.' });
  });

  it('denies an operation source that is not the wallet', () => {
    const result = evaluate(buildTx(wallet, [claimOp(wallet, { source: stranger })]));
    expect(result).toEqual({ verdict: 'deny', reason: 'The operation source must be your wallet.' });
  });

  it('denies a fee above maxFeeStroops', () => {
    const result = evaluate(buildTx(wallet, [claimOp(wallet)], { fee: '50000001' }));
    expect(result).toEqual({
      verdict: 'deny',
      reason: 'The transaction fee is above the limit of 50000000 stroops.',
    });
  });

  it('accepts a fee equal to maxFeeStroops', () => {
    expect(evaluate(buildTx(wallet, [claimOp(wallet)], { fee: '50000000' })).verdict).toBe('approve');
  });

  it('denies a transaction without maxTime', () => {
    const transaction = new TransactionBuilder(new Account(wallet, '1'), {
      fee: '1000',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(claimOp(wallet))
      .setTimeout(TimeoutInfinite)
      .build();
    expect(evaluate(transaction)).toEqual({ verdict: 'deny', reason: 'The transaction must have an expiry time.' });
  });

  it('denies a maxTime too far in the future', () => {
    const maxTime = NOW_SECONDS + POLICY.maxValiditySeconds + 1;
    const result = evaluate(buildTx(wallet, [claimOp(wallet)], { maxTime }));
    expect(result).toEqual({ verdict: 'deny', reason: 'The transaction must expire within 7200 seconds.' });
  });
});

describe('evaluateRequest: operation rules', () => {
  it('denies address credentials in the auth entries', () => {
    const args = subscriptionArgs(wallet, 0, 1n);
    const auth = [addressAuth(DEAL.dealContractId, 'subscribe', args, wallet)];
    const result = evaluate(buildTx(wallet, [contractCall(DEAL.dealContractId, 'subscribe', args, { auth })]));
    expect(result).toEqual({
      verdict: 'deny',
      reason: 'Every authorization must use the transaction source account.',
    });
  });

  it('denies an auth entry whose root invocation is another call', () => {
    const args = subscriptionArgs(wallet, 0, 1n);
    const auth = [sourceAuth(DEAL.dealContractId, 'subscribe', subscriptionArgs(wallet, 0, 9n))];
    const result = evaluate(buildTx(wallet, [contractCall(DEAL.dealContractId, 'subscribe', args, { auth })]));
    expect(result).toEqual({ verdict: 'deny', reason: 'The authorization does not match the contract call.' });
  });

  it('denies a call to an unknown contract', () => {
    const unknown = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    const result = evaluate(buildTx(wallet, [subscribeOp(wallet, 1n, { contract: unknown })]));
    expect(result).toEqual({ verdict: 'deny', reason: GENERAL_DENIAL });
  });

  it('denies a transfer on a note token', () => {
    const args = [addressArg(wallet), addressArg(stranger), nativeToScVal(1n, { type: 'i128' })];
    const result = evaluate(buildTx(wallet, [contractCall(NOTE_TOKEN, 'transfer', args)]));
    expect(result).toEqual({ verdict: 'deny', reason: GENERAL_DENIAL });
  });

  it('denies another function on a listed deal contract', () => {
    const result = evaluate(buildTx(wallet, [contractCall(DEAL.dealContractId, 'close', [])]));
    expect(result).toEqual({ verdict: 'deny', reason: GENERAL_DENIAL });
  });

  it('denies a claim on the deal contract (claim belongs to the paying agent)', () => {
    const result = evaluate(buildTx(wallet, [claimOp(wallet, { contract: DEAL.dealContractId })]));
    expect(result).toEqual({ verdict: 'deny', reason: GENERAL_DENIAL });
  });

  it('denies an investor argument that is not the wallet', () => {
    const result = evaluate(buildTx(wallet, [subscribeOp(stranger, 1n)]));
    expect(result).toEqual({ verdict: 'deny', reason: 'The investor argument must be your wallet.' });
  });

  it('denies a claim for another holder', () => {
    const result = evaluate(buildTx(wallet, [claimOp(stranger)]));
    expect(result).toEqual({ verdict: 'deny', reason: 'The holder argument must be your wallet.' });
  });

  it('denies zero notes', () => {
    const result = evaluate(buildTx(wallet, [cancelOp(wallet, 0n)]));
    expect(result).toEqual({ verdict: 'deny', reason: 'The number of notes must be above zero.' });
  });

  it('denies arguments of the wrong type', () => {
    const args = [addressArg(wallet), nativeToScVal(0, { type: 'u64' }), nativeToScVal(1n, { type: 'i128' })];
    const result = evaluate(buildTx(wallet, [contractCall(DEAL.dealContractId, 'subscribe', args)]));
    expect(result).toEqual({
      verdict: 'deny',
      reason: 'The subscribe call must have the arguments (investor, class, notes).',
    });
  });

  it('denies a ChangeTrust on another asset', () => {
    const otherCode = evaluate(buildTx(wallet, [changeTrustOp(new Asset('USDC', POLICY.eurc.issuer))]));
    const otherIssuer = evaluate(buildTx(wallet, [changeTrustOp(new Asset('EURC', OTHER_ISSUER))]));
    expect(otherCode).toEqual({ verdict: 'deny', reason: GENERAL_DENIAL });
    expect(otherIssuer).toEqual({ verdict: 'deny', reason: GENERAL_DENIAL });
  });

  it('denies a classic payment', () => {
    const payment = Operation.payment({ destination: stranger, asset: eurc(), amount: '10' });
    expect(evaluate(buildTx(wallet, [payment]))).toEqual({ verdict: 'deny', reason: GENERAL_DENIAL });
  });

  it('denies a host function that is not a contract call', () => {
    const upload = Operation.uploadContractWasm({ wasm: Buffer.from([0, 97, 115, 109]) });
    expect(evaluate(buildTx(wallet, [upload]))).toEqual({ verdict: 'deny', reason: GENERAL_DENIAL });
  });
});
