import { describe, expect, it } from 'vitest';
import { cronExpression, parseCheckerEnvironment } from '../src/checker/config.js';
import { toPendingApproval } from '../src/checker/dfns.js';
import { parseServerEnvironment } from '../src/config.js';
import { signatureFromPolicyPending } from '../src/custody/dfns.js';
import { FundingError, createFriendbotFunder } from '../src/funding/friendbot.js';
import { formatUnits, toBaseUnits } from '../src/policy/amounts.js';
import { loadPolicy, parsePolicy } from '../src/policy/policy.js';
import { hexToBase64 } from '../src/signing/envelope.js';
import { POLICY } from './helpers.js';

type ApprovalItem = Parameters<typeof toPendingApproval>[0];

describe('policy file', () => {
  it('loads testnet.json with its four deals', () => {
    const policy = loadPolicy('testnet');
    expect(policy.deals.map((deal) => deal.dealContractId)).toEqual([
      'CB3S3NWG7IUKUBAWAAJPFKVMCIMTRJ73GHZX6YZASRMZPVUGYFLCATJ4',
      'CBVCKQH6CSGRS5W7SYZAJJ3MH5QUWNX7HKWTSLXK4YHPOSY3YZJ2I7AP',
      'CDP3NNLBJ7E5ZWJMUTMBPEJP2KB4UNOQ2KXMINAMO7NQAESQMKQ46SPL',
      'CBNPFPUNWJEKX5EJHFS2BJI43V4DN4WWRGTDH44ZKEEN26ZGQWVHOQ2C',
    ]);
    expect(policy.thresholdEurc).toBe('250');
  });

  it('refuses a bad contract id and a wrong passphrase', () => {
    const badDeal = { ...POLICY.deals[0], dealContractId: 'CNOTAVALIDID' };
    expect(() => parsePolicy({ ...POLICY, deals: [badDeal] })).toThrow(/deals\.0\.dealContractId/);
    expect(() => parsePolicy({ ...POLICY, networkPassphrase: 'Public Global Stellar Network ; September 2015' })).toThrow(
      /networkPassphrase/,
    );
  });
});

describe('amounts', () => {
  it('converts decimals to base units and back without floats', () => {
    expect(toBaseUnits('250', 7)).toBe(2_500_000_000n);
    expect(toBaseUnits('250.5', 7)).toBe(2_505_000_000n);
    expect(formatUnits(2_505_000_000n, 7)).toBe('250.5');
    expect(formatUnits(1n, 7)).toBe('0.0000001');
    expect(() => toBaseUnits('1.00000001', 7)).toThrow();
  });
});

describe('Dfns adapters', () => {
  it('reads a pending signature from a PolicyPendingError body', () => {
    const fromSignature = signatureFromPolicyPending({ id: 'sig-1', status: 'Pending', approvalId: 'ap-1', keyId: 'key-1' });
    expect(fromSignature).toEqual({ signatureId: 'sig-1', status: 'Pending', approvalId: 'ap-1' });
    const fromApproval = signatureFromPolicyPending({
      id: 'ap-2',
      status: 'Pending',
      activity: { kind: 'Wallets:Sign', signatureRequest: { id: 'sig-2', status: 'Pending' } },
    });
    expect(fromApproval).toEqual({ signatureId: 'sig-2', status: 'Pending', approvalId: 'ap-2' });
    expect(signatureFromPolicyPending({ unexpected: true })).toBeNull();
  });

  it('maps a Dfns approval item to the checker shape', () => {
    const item = {
      id: 'ap-1',
      initiatorId: 'us-1',
      status: 'Pending',
      dateUpdated: '2026-11-02T12:00:00Z',
      policyEvaluations: [],
      decisions: [],
      activity: {
        kind: 'Wallets:Sign',
        signatureRequest: {
          id: 'sig-1',
          keyId: 'key-1',
          status: 'Pending',
          requestBody: { kind: 'Transaction', network: 'StellarTestnet', transaction: '0xabcd' },
        },
      },
    } as unknown as ApprovalItem;
    expect(toPendingApproval(item)).toEqual({
      id: 'ap-1',
      activityKind: 'Wallets:Sign',
      decisionCount: 0,
      signature: { keyId: 'key-1', requestKind: 'Transaction', network: 'StellarTestnet', transaction: '0xabcd' },
    });
    const transfer = {
      ...item,
      activity: { kind: 'Wallets:Sign', transferRequest: { id: 'xfr-1', walletId: 'wa-9' } },
    } as unknown as ApprovalItem;
    expect(toPendingApproval(transfer)).toMatchObject({ walletId: 'wa-9' });
  });

  it('decodes hex with or without 0x', () => {
    expect(hexToBase64('0x0102')).toBe('AQI=');
    expect(hexToBase64('0102')).toBe('AQI=');
    expect(hexToBase64('0x123')).toBeNull();
    expect(hexToBase64('0xzz')).toBeNull();
  });
});

describe('Friendbot funder', () => {
  const answer = (status: number, body = '') => async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });

  it('sends one GET with the address and accepts an existing account', async () => {
    const urls: string[] = [];
    const funder = createFriendbotFunder('https://friendbot.example/', async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => '' };
    });
    await funder.fund('GABC');
    expect(urls).toEqual(['https://friendbot.example/?addr=GABC']);
    await expect(
      createFriendbotFunder('https://friendbot.example/', answer(400, '{"detail":"createAccountAlreadyExist"}')).fund('GABC'),
    ).resolves.toBeUndefined();
  });

  it('gives a FundingError on another failure', async () => {
    await expect(createFriendbotFunder('https://friendbot.example/', answer(500)).fund('GABC')).rejects.toBeInstanceOf(
      FundingError,
    );
  });
});

describe('configuration', () => {
  const initiator = {
    DATABASE_URL: 'postgresql://localhost/cara7_custody?schema=custody',
    DFNS_ORG_ID: 'or-1',
    DFNS_AUTH_TOKEN: 'token',
    DFNS_CRED_ID: 'cred',
    DFNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
  };
  const checker = {
    DFNS_ORG_ID: 'or-1',
    CHECKER_DFNS_AUTH_TOKEN: 'token',
    CHECKER_DFNS_CRED_ID: 'cred',
    CHECKER_DFNS_PRIVATE_KEY: 'key',
  };

  it('gives the server its defaults without any checker variable', () => {
    const environment = parseServerEnvironment(initiator);
    expect(environment.PORT).toBe(8091);
    expect(environment.CORS_ORIGIN).toBe('http://localhost:3001');
    expect(environment.DFNS_PRIVATE_KEY).toContain('\nabc\n');
  });

  it('gives the checker its defaults without any initiator variable', () => {
    const environment = parseCheckerEnvironment(checker);
    expect(environment.CHECKER_INTERVAL_SECONDS).toBe(5);
    expect(() => parseCheckerEnvironment({ ...initiator })).toThrow(/CHECKER_DFNS_AUTH_TOKEN/);
  });

  it('builds the cron expression for seconds and minutes', () => {
    expect(cronExpression(5)).toBe('*/5 * * * * *');
    expect(cronExpression(120)).toBe('0 */2 * * * *');
  });
});
