import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { ELIGIBLE_BATCH, eligibleRequests, parseEligible } from '../src/custody/eligible.js';
import { fakeServices } from './support/fakes.js';

const deal = StrKey.encodeContract(Keypair.random().rawPublicKey());
const holders = (count: number): string[] => Array.from({ length: count }, () => Keypair.random().publicKey());

describe('deal:eligible arguments', () => {
  it('reads --deal with --add or --remove and a list of accounts', () => {
    const [first, second] = holders(2) as [string, string];
    expect(parseEligible(['--deal', deal, '--add', `${first}, ${second}`])).toEqual({
      deal,
      holders: [first, second],
      eligible: true,
    });
    expect(parseEligible(['--deal', deal, '--remove', first])).toEqual({ deal, holders: [first], eligible: false });
  });

  it('refuses a missing deal, both actions, no action and bad accounts', () => {
    const [holder] = holders(1) as [string];
    expect(() => parseEligible(['--add', holder])).toThrow(/--deal is missing/);
    expect(() => parseEligible(['--deal', holder, '--add', holder])).toThrow(/not a contract address/);
    expect(() => parseEligible(['--deal', deal])).toThrow(/Give --add or --remove/);
    expect(() => parseEligible(['--deal', deal, '--add', holder, '--remove', holder])).toThrow(/Give --add or --remove/);
    expect(() => parseEligible(['--deal', deal, '--add', ''])).toThrow(/at least one account/);
    expect(() => parseEligible(['--deal', deal, '--add', deal])).toThrow(/not an account address/);
    expect(() => parseEligible(['--deal', deal, '--add', `${holder},${holder}`])).toThrow(/two times/);
    expect(() => parseEligible(['--deal', deal, '--holders', holder])).toThrow();
  });
});

describe('deal:eligible requests', () => {
  it('asks the admin to sign set_eligible, in batches', () => {
    const list = holders(ELIGIBLE_BATCH + 5);
    const requests = eligibleRequests({ deal, holders: list, eligible: true });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({ role: 'admin', kind: 'add-eligible' });
      expect(request.call).toMatchObject({ type: 'contract', contractId: deal, method: 'set_eligible' });
    }
    expect(eligibleRequests({ deal, holders: [], eligible: true })).toEqual([]);
  });

  it('sends the holders and the flag as the contract arguments', async () => {
    const { operator, network, custody } = fakeServices();
    const list = holders(3);
    const [request] = eligibleRequests({ deal, holders: list, eligible: false });
    if (!request) throw new Error('eligibleRequests gave no request.');
    const operation = await operator.run(request);
    expect(operation.status).toBe('done');
    expect(network.submitted[0]).toMatchObject({
      contractId: deal,
      method: 'set_eligible',
      args: [list, false],
    });
    expect(network.submitted[0]?.transaction.source).toBe(custody.address('admin'));
  });
});
