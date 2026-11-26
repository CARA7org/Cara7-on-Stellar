import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PolicyPendingError } from '@dfns/sdk';
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { environmentSchema } from '../src/config.js';
import { DfnsCustody, dfnsNetwork, toSignatureState, type DfnsApi } from '../src/custody/dfns.js';
import type { Operator } from '../src/custody/operator.js';
import type { Operation as OperatorOperation } from '../src/custody/operations.js';
import {
  assetOverride,
  classicAssetOfSac,
  parseTrust,
  trustAsset,
  trustRequest,
} from '../src/custody/trust.js';
import { waitForOperation } from '../src/custody/wait.js';
import { parseWiring } from '../src/custody/wire-deal.js';
import { projectRoot } from '../src/paths.js';
import { FakeNetwork, TEST_EURC, fakeServices } from './support/fakes.js';

/** The CARA7 test EURC as a classic asset. */
const eurc = new Asset('EURC', 'GCB6FLVHX7OXWSUHP76WGPVOJLGPB6FGXAQKMVSWPNP6NFUWNOHQMXQA');

describe('configuration holds no Stellar secret', () => {
  it('has no setting whose name ends in _SECRET', () => {
    const keys = Object.keys(environmentSchema.shape);
    expect(keys.filter((key) => key.endsWith('_SECRET'))).toEqual([]);
  });

  it('.env.example holds no Stellar secret seed', () => {
    const example = readFileSync(path.join(projectRoot, '.env.example'), 'utf8');
    expect(example).not.toMatch(/S[A-Z2-7]{55}/);
    expect(example).toContain('DFNS_SERVICER_WALLET_ID');
  });
});

function transaction() {
  const source = new Account(Keypair.random().publicKey(), '7');
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: '9' }))
    .setTimeout(60)
    .build();
}

const wallet = { network: 'StellarTestnet', address: 'GADDRESS', signingKey: { id: 'key-1' } };
const settings = { DFNS_API_URL: 'https://api.dfns.io', DFNS_SERVICER_WALLET_ID: 'wa-servicer' };

function fakeDfns(generate?: DfnsApi['keys']['generateSignature']) {
  const calls = { getWallet: 0, bodies: [] as unknown[] };
  const api: DfnsApi = {
    wallets: {
      getWallet: async () => {
        calls.getWallet += 1;
        return wallet;
      },
    },
    keys: {
      generateSignature:
        generate ??
        (async (request) => {
          calls.bodies.push(request.body);
          return { id: 'sig-1', status: 'Pending', approvalId: 'ap-1' };
        }),
      getSignature: async () => ({
        id: 'sig-1',
        status: 'Rejected',
        reason: 'Denied by the approver.',
      }),
    },
  };
  return { api, calls };
}

describe('Dfns custody adapter', () => {
  it('maps the network passphrase to the Dfns network', () => {
    expect(dfnsNetwork(Networks.TESTNET)).toBe('StellarTestnet');
    expect(dfnsNetwork(Networks.PUBLIC)).toBe('Stellar');
    expect(() => dfnsNetwork('Standalone Network ; February 2017')).toThrow(/only/);
  });

  it('turns the signed hex envelope into base64 XDR', () => {
    const prepared = transaction();
    const hex = `0x${prepared.toEnvelope().toXDR('hex')}`;
    const state = toSignatureState({ id: 'sig-1', status: 'Signed', signedData: hex });
    expect(state).toMatchObject({ status: 'signed', signedXdr: prepared.toXDR() });
    expect(toSignatureState({ id: 'sig-2', status: 'Signed' }).status).toBe('failed');
  });

  it('sends 0x hex, reads the wallet once, and keeps only a short externalId', async () => {
    const { api, calls } = fakeDfns();
    const custody = new DfnsCustody(settings, Networks.TESTNET, api);
    const prepared = transaction();
    const role = 'servicer';
    const input = { role, transaction: prepared } as const;
    const state = await custody.requestSignature({ ...input, externalId: 'c-1' });
    await custody.requestSignature({ ...input, externalId: 'x'.repeat(51) });
    expect(state).toEqual({ signatureId: 'sig-1', status: 'pending', approvalId: 'ap-1' });
    expect(calls.getWallet).toBe(1);
    expect(calls.bodies[0]).toEqual({
      kind: 'Transaction',
      network: 'StellarTestnet',
      transaction: `0x${prepared.toEnvelope().toXDR('hex')}`,
      externalId: 'c-1',
    });
    expect(calls.bodies[1]).not.toHaveProperty('externalId');
  });

  it('reads an HTTP 202 (PolicyPendingError) as a pending signature', async () => {
    const { api } = fakeDfns(async () => {
      const body = { id: 'sig-9', keyId: 'key-1', status: 'Pending', approvalId: 'ap-9' };
      throw new PolicyPendingError(body);
    });
    const custody = new DfnsCustody(settings, Networks.TESTNET, api);
    const state = await custody.requestSignature({ role: 'servicer', transaction: transaction() });
    expect(state).toMatchObject({ status: 'pending', approvalId: 'ap-9', signatureId: 'sig-9' });
  });

  it('gives the Dfns reason of a rejection', async () => {
    const custody = new DfnsCustody(settings, Networks.TESTNET, fakeDfns().api);
    expect(await custody.refreshSignature('servicer', 'sig-1')).toMatchObject({
      status: 'rejected',
      reason: 'Denied by the approver.',
    });
  });

  it('refuses a wallet on another network and names a missing setting', async () => {
    const onPublic = new DfnsCustody(settings, Networks.PUBLIC, fakeDfns().api);
    await expect(onPublic.resolveRole('servicer')).rejects.toThrow(
      /is on StellarTestnet, but this backend uses Stellar/,
    );
    const unset = new DfnsCustody(settings, Networks.TESTNET);
    await expect(unset.resolveRole('admin')).rejects.toThrow(/^DFNS_ADMIN_WALLET_ID is not set/);
    await expect(unset.resolveRole('servicer')).rejects.toThrow(/^DFNS_AUTH_TOKEN is not set/);
  });
});

function quietWait(operator: Operator, operation: OperatorOperation) {
  return waitForOperation(operator, operation, { log: () => {}, sleep: async () => {} });
}

describe('CLI wait mode', () => {
  it('prints the approval id, polls every 5 s and returns with the signature', async () => {
    const { operator, custody, network } = fakeServices({ reporter: 'approval' });
    const lines: string[] = [];
    const sleeps: number[] = [];
    const pending = await operator.run(trustRequest('reporter', eurc, false));
    const done = await waitForOperation(operator, pending, {
      log: (line) => lines.push(line),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        if (sleeps.length === 2) custody.approve(pending.signatureId ?? '');
      },
    });
    expect(done.status).toBe('done');
    expect(lines).toEqual([`Awaiting approval ${pending.approvalId}: approve it in app.dfns.io`]);
    expect(sleeps).toEqual([5000, 5000]);
    expect(network.submitted).toHaveLength(1);
  });

  it('stops with the reason on a rejection, and after 60 minutes with no decision', async () => {
    const { operator, custody } = fakeServices({ admin: 'approval', reporter: 'approval' });
    const rejected = await operator.run(trustRequest('admin', eurc, false));
    custody.reject(rejected.signatureId ?? '', 'Wrong asset.');
    await expect(quietWait(operator, rejected)).rejects.toThrow(
      'The custody provider rejected the signature: Wrong asset.',
    );
    const silent = await operator.run(trustRequest('reporter', eurc, false));
    await expect(quietWait(operator, silent)).rejects.toThrow(/No decision after 60 minutes/);
  });
});

describe('classic ChangeTrust and deal wiring', () => {
  it('signs a ChangeTrust for EURC with the role wallet and sends it to Horizon', async () => {
    const { operator, network, custody } = fakeServices();
    const added = await operator.run(trustRequest('servicer', eurc, false));
    const removed = await operator.run(trustRequest('servicer', eurc, true));
    expect([added.status, removed.status]).toEqual(['done', 'done']);
    expect(network.submitted.map((entry) => entry.kind)).toEqual(['classic', 'classic']);
    const [add, remove] = network.submitted.map((entry) => entry.transaction.operations[0]);
    expect(add).toMatchObject({ type: 'changeTrust', limit: '922337203685.4775807' });
    expect(remove).toMatchObject({ type: 'changeTrust', limit: '0.0000000' });
    expect(add).toMatchObject({ line: { code: 'EURC' } });
    expect(network.submitted[0]?.transaction.source).toBe(custody.address('servicer'));
    expect(added.hash).toBe(network.submitted[0]?.transaction.hash().toString('hex'));
  });

  it('parses the trust and wiring arguments', () => {
    const trust = parseTrust(['--role', 'servicer', '--remove']);
    expect(trust).toEqual({ role: 'servicer', remove: true });
    expect(() => parseTrust(['--role', 'owner'])).toThrow(/--role/);
    const note = 'CAXBYHZVHXOP3HQCMXPPVZMDUYEO27CTQQQDMWVNMMGSRCBSJHGIARZW';
    const deal = 'CB3S3NWG7IUKUBAWAAJPFKVMCIMTRJ73GHZX6YZASRMZPVUGYFLCATJ4';
    const wiring = ['--deal', deal, '--notes', `${note},${note}`, '--paying-agent', note];
    expect(parseWiring(wiring)).toEqual({ deal, notes: [note, note], payingAgent: note });
    const badDeal = ['--deal', 'GABC', '--notes', note, '--paying-agent', note];
    expect(() => parseWiring(badDeal)).toThrow(/contract address/);
  });
});

describe('the classic asset of the servicer trustline', () => {
  const settings = {
    EURC_CODE: undefined,
    EURC_ISSUER: undefined,
    DEAL_CONTRACT_ID: 'CB3S3NWG7IUKUBAWAAJPFKVMCIMTRJ73GHZX6YZASRMZPVUGYFLCATJ4',
    NETWORK_PASSPHRASE: Networks.TESTNET,
  };

  it('reads CODE:ISSUER from the name() of the deal asset contract', async () => {
    const network = new FakeNetwork();
    const asset = await trustAsset(network.read.bind(network), settings);
    expect(asset.equals(eurc)).toBe(true);
  });

  it('keeps EURC_CODE and EURC_ISSUER only as an override, and needs both of them', async () => {
    const issuer = Keypair.random().publicKey();
    const override = { ...settings, EURC_CODE: 'EURCV', EURC_ISSUER: issuer };
    const noRead = async (): Promise<unknown> => {
      throw new Error('An override needs no read.');
    };
    expect((await trustAsset(noRead, override)).equals(new Asset('EURCV', issuer))).toBe(true);
    expect(assetOverride({})).toBeNull();
    expect(() => assetOverride({ EURC_CODE: 'EURC' })).toThrow(/both EURC_CODE and EURC_ISSUER/);
  });

  it('refuses a contract that is not the Stellar Asset Contract of its name', () => {
    const circle = 'CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ';
    expect(() => classicAssetOfSac(TEST_EURC.name, circle, Networks.TESTNET)).toThrow(
      /is not the Stellar Asset Contract of/,
    );
    expect(() => classicAssetOfSac('Euro Coin', TEST_EURC.sac, Networks.TESTNET)).toThrow(/CODE:ISSUER/);
    expect(() => classicAssetOfSac('native', TEST_EURC.sac, Networks.TESTNET)).toThrow(/XLM/);
  });
});
