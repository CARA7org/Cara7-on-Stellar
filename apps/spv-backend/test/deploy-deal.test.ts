import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, Networks, StrKey, scValToNative, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  WASM_FILES,
  checkRegistrable,
  checkRoles,
  codeFromDeal,
  codeFromWasmDir,
  dealConfigArg,
  deployDeal,
  deployRecord,
  deployRequest,
  noteTokenArgs,
  parseDeployArgs,
  payingAgentArgs,
  trancheBodies,
  uploadRequest,
  type DeployContext,
  type DeployOptions,
} from '../src/custody/deploy-deal.js';
import type { Operator } from '../src/custody/operator.js';
import type { AssetInfo } from '../src/deals/assets.js';
import { dealOnChainConfig, loadDealConfig, parseDealConfig, resolveDealTerms, type DealTerms } from '../src/deals/config.js';
import { decodeDealConfig, type OnChainDealConfig } from '../src/deals/onchain.js';
import { projectRoot } from '../src/paths.js';
import { TEST_EURC, fakeServices, type FakeNetwork } from './support/fakes.js';
import { loadVector } from './support/vectors.js';

const contract = (): string => StrKey.encodeContract(Keypair.random().rawPublicKey());
const account = (): string => Keypair.random().publicKey();
const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    network: 'testnet',
    name: 'Test deal (Series 9)',
    series: '9',
    asset: TEST_EURC.sac,
    denominationCurrency: 'EUR',
    denomination: '10',
    roundUnit: '0.01',
    reserve: '5',
    feesPerPeriod: '0.10',
    daysInPeriod: 90,
    oracle: contract(),
    oracleMaxStalenessSecs: 604_800,
    seller: account(),
    feesRecipient: account(),
    classes: [
      { letter: 'A', label: 'SENIOR', rate: { kind: 'floating', spreadPct: '0.60' }, notes: 4 },
      { letter: 'B', label: 'MEZZANINE', rate: { kind: 'fixed', ratePct: '1.50' }, notes: 3 },
      { letter: 'C', label: 'MEZZANINE', rate: { kind: 'fixed', ratePct: '2.50' }, notes: 2 },
      { letter: 'D', label: 'JUNIOR', rate: { kind: 'fixed', ratePct: '4.00' }, notes: 1, name: 'Junior D', symbol: 'JRD9' },
    ],
    eligible: [account(), account()],
    ...overrides,
  };
}

const asset: AssetInfo = { contractId: TEST_EURC.sac, name: TEST_EURC.name, symbol: 'EURC', decimals: 7 };
const termsOf = (raw: Record<string, unknown> = rawConfig()): DealTerms => resolveDealTerms(parseDealConfig(raw), 7);
const roles = { admin: account(), servicer: account() };
const native = (args: xdr.ScVal[]): unknown[] => args.map((arg) => scValToNative(arg) as unknown);

/** A temporary folder with a deal config and three small wasm modules. */
function workspace(raw: Record<string, unknown> = rawConfig()): { dir: string; config: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cara7-deploy-'));
  const config = path.join(dir, 'deal.json');
  writeFileSync(config, JSON.stringify(raw));
  for (const file of Object.values(WASM_FILES)) {
    writeFileSync(path.join(dir, file), Buffer.concat([WASM_HEADER, Buffer.from(file)]));
  }
  return { dir, config };
}

function deployContext(operator: Operator, network: FakeNetwork, overrides: Partial<DeployContext> = {}): DeployContext {
  return {
    operator,
    read: network.read.bind(network),
    networkPassphrase: Networks.TESTNET,
    codeExists: async () => false,
    codeHashOf: async () => {
      throw new Error('This test reads no deployed code.');
    },
    log: () => {},
    ...overrides,
  };
}

function options(config: string, wasmDir: string, registerUrl: string | null = null): DeployOptions {
  return { configPath: config, wasmDir, fromDeal: null, registerUrl };
}

describe('deal:deploy arguments', () => {
  const deal = contract();

  it('needs --config and one source of contract code', () => {
    expect(parseDeployArgs(['--config', 'deals/a.json', '--wasm-dir', 'release'])).toEqual({
      configPath: 'deals/a.json',
      wasmDir: 'release',
      fromDeal: null,
      registerUrl: null,
      savePath: null,
    });
    const withAll = ['--config', 'a.json', '--from-deal', deal, '--register', 'http://localhost:8080/', '--save', 'out/deal.json'];
    expect(parseDeployArgs(withAll)).toEqual({
      configPath: 'a.json',
      wasmDir: null,
      fromDeal: deal,
      registerUrl: 'http://localhost:8080',
      savePath: 'out/deal.json',
    });
    expect(() => parseDeployArgs(['--wasm-dir', 'release'])).toThrow(/--config is missing/);
    expect(() => parseDeployArgs(['--config', 'a.json'])).toThrow(/Give --wasm-dir or --from-deal/);
    const both = ['--config', 'a.json', '--wasm-dir', 'release', '--from-deal', deal];
    expect(() => parseDeployArgs(both)).toThrow(/Give --wasm-dir or --from-deal/);
    expect(() => parseDeployArgs(['--config', 'a.json', '--from-deal', account()])).toThrow(/not a contract address/);
    const noScheme = ['--config', 'a.json', '--wasm-dir', 'release', '--register', 'localhost:8080'];
    expect(() => parseDeployArgs(noScheme)).toThrow(/http or https/);
  });

  it('has no flag of the old copy of the reference deal', () => {
    expect(() => parseDeployArgs(['--config', 'a.json', '--wasm-dir', 'release', '--classes', '10,5,3'])).toThrow();
  });
});

describe('deal:deploy constructor arguments', () => {
  it('builds DealConfig from the config, with the operator wallets as admin and servicer', () => {
    const raw = rawConfig();
    const config = dealConfigArg(termsOf(raw), roles);
    const keys = config.map()?.map((entry) => entry.key().sym().toString()) ?? [];
    expect(keys).toEqual([...keys].sort());
    const rank = (id: string, ...items: unknown[]): unknown => ({ id, when: ['Always'], alloc: ['Sequential'], items });
    // A version 1 file is the reference order, with a floor of 0 % on the floating class.
    expect(scValToNative(config)).toEqual({
      admin: roles.admin,
      servicer: roles.servicer,
      asset: TEST_EURC.sac,
      oracle: raw.oracle,
      seller: raw.seller,
      note_denomination: 100_000_000n,
      round_unit: 100_000n,
      days_in_period: 90,
      oracle_max_staleness_secs: 604_800n,
      classes: [
        { rate: ['Floating', 600n], total_notes: 4n, floor: 0n, index_floor: null },
        { rate: ['Fixed', 1500n], total_notes: 3n, floor: null, index_floor: null },
        { rate: ['Fixed', 2500n], total_notes: 2n, floor: null, index_floor: null },
        { rate: ['Fixed', 4000n], total_notes: 1n, floor: null, index_floor: null },
      ],
      fees: [{ recipient: raw.feesRecipient, amount: ['Fixed', 1_000_000n] }],
      reserve: { required: ['Fixed', 50_000_000n], release: ['Full'], draw_ranks: [] },
      triggers: [],
      normal: [
        rank('fees', ['Fee', 0]),
        rank('int_a', ['Interest', 0]),
        rank('int_b', ['Interest', 1]),
        rank('int_c', ['Interest', 2]),
        rank('int_d', ['Interest', 3]),
        rank('reserve', ['ReserveRefill']),
        rank('principal', ['Principal', 0], ['Principal', 1], ['Principal', 2], ['Principal', 3]),
        rank('residual', ['Residual']),
      ],
      enforced: [
        rank('fees', ['Fee', 0]),
        rank('acc_a', ['Interest', 0], ['Principal', 0]),
        rank('acc_b', ['Interest', 1], ['Principal', 1]),
        rank('acc_c', ['Interest', 2], ['Principal', 2]),
        rank('acc_d', ['Interest', 3], ['Principal', 3]),
        rank('residual', ['Residual']),
      ],
    });
  });

  it('gives the two testnet deal files the structures that the contract tests run', () => {
    // The deal files of the runs, with an address in each placeholder,
    // against the configurations of the contract vectors. Only the
    // addresses can differ.
    const filled = (value: unknown): unknown => {
      if (typeof value === 'string' && /^<[\s\S]*>$/.test(value)) return account();
      if (Array.isArray(value)) return value.map(filled);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, filled(item)]));
      }
      return value;
    };
    const withoutAddresses = (config: OnChainDealConfig): unknown => ({
      ...config,
      admin: '',
      servicer: '',
      seller: '',
      asset: '',
      oracle: '',
      fees: config.fees.map((line) => line.amount),
    });
    for (const [file, vectorName] of [['d2-demo.testnet.json', 'deal-s'], ['d1-prorata.testnet.json', 'deal-p']] as const) {
      const raw = JSON.parse(readFileSync(path.join(projectRoot, 'deals', file), 'utf8')) as unknown;
      const terms = resolveDealTerms(parseDealConfig(filled(raw)), 7);
      const expected = decodeDealConfig(scValToNative(xdr.ScVal.fromXDR(loadVector(vectorName).config_xdr, 'hex')));
      expect(withoutAddresses(dealOnChainConfig(terms, roles)), file).toEqual(withoutAddresses(expected));
    }
  });

  it('names the note tokens from the config, or by series and class', () => {
    const terms = termsOf();
    const [, classB, , classD] = terms.classes;
    if (!classB || !classD) throw new Error('The test config has 4 classes.');
    const deal = contract();
    expect(native(noteTokenArgs(deal, classB, terms.denomination))).toEqual([
      deal,
      'CARA7 Series 9 Class B Notes',
      'CARA7B9',
      100_000_000n,
    ]);
    expect(native(noteTokenArgs(deal, classD, terms.denomination))).toEqual([deal, 'Junior D', 'JRD9', 100_000_000n]);
    const notes = [contract(), contract()];
    expect(native(payingAgentArgs(deal, TEST_EURC.sac, notes))).toEqual([deal, TEST_EURC.sac, notes]);
  });
});

describe('deal:deploy registry', () => {
  it('registers each class with its index, label, rate kind, coupon and face', () => {
    const notes = [contract(), contract(), contract(), contract()];
    const common = { baseAssetId: TEST_EURC.sac, assetSymbol: 'EURC', assetDecimals: 7 };
    expect(trancheBodies(termsOf(), asset, notes)).toEqual([
      { classIndex: 0, name: 'Class A Notes', seniority: 'SENIOR', rateKind: 'FLOATING', couponBps: 60, contractId: notes[0], originalFace: '400000000', ...common },
      { classIndex: 1, name: 'Class B Notes', seniority: 'MEZZANINE', rateKind: 'FIXED', couponBps: 150, contractId: notes[1], originalFace: '300000000', ...common },
      { classIndex: 2, name: 'Class C Notes', seniority: 'MEZZANINE', rateKind: 'FIXED', couponBps: 250, contractId: notes[2], originalFace: '200000000', ...common },
      { classIndex: 3, name: 'Class D Notes', seniority: 'JUNIOR', rateKind: 'FIXED', couponBps: 400, contractId: notes[3], originalFace: '100000000', ...common },
    ]);
  });

  it('stops before the first transaction when the registry cannot take the deal', () => {
    expect(() => checkRegistrable(termsOf(), asset)).not.toThrow();
    expect(() => checkRegistrable(termsOf(rawConfig({ daysInPeriod: 91 })), asset)).toThrow(/at most 90 days/);
    const oddRate = [{ letter: 'A', label: 'SENIOR', rate: { kind: 'fixed', ratePct: '1.505' }, notes: 1 }];
    expect(() => checkRegistrable(termsOf(rawConfig({ classes: oddRate })), asset)).toThrow(
      /not a whole number of basis points/,
    );
    expect(() => checkRegistrable(termsOf(), { ...asset, symbol: 'A_VERY_LONG_SYMBOL' })).toThrow(/asset symbol/);
  });
});

describe('deal:deploy contract code', () => {
  it('uploads a wasm with the crank and gives its code hash', async () => {
    const { operator, network, custody } = fakeServices();
    const wasm = Buffer.concat([WASM_HEADER, Buffer.from('deal')]);
    const operation = await operator.run(uploadRequest('upload-deal', wasm));
    expect(operation.status).toBe('done');
    expect(operation.result).toBe(createHash('sha256').update(wasm).digest('hex'));
    expect(network.submitted[0]).toMatchObject({ kind: 'contract', method: 'upload' });
    expect(network.submitted[0]?.transaction.source).toBe(custody.address('crank'));
  });

  it('uploads only the code that is not on chain yet', async () => {
    const { dir } = workspace();
    const { operator, network } = fakeServices();
    const dealCode = createHash('sha256').update(readFileSync(path.join(dir, WASM_FILES.deal))).digest();
    const context = deployContext(operator, network, { codeExists: async (hash) => hash.equals(dealCode) });
    const code = await codeFromWasmDir(context, dir);
    expect(code.deal.equals(dealCode)).toBe(true);
    expect(network.methods()).toEqual(['upload', 'upload']);
    expect(network.submitted.map((entry) => entry.wasm?.toString('latin1').slice(8))).toEqual([
      WASM_FILES.note,
      WASM_FILES.agent,
    ]);
  });

  it('refuses a folder without the wasm files, before any upload', async () => {
    const { operator, network } = fakeServices();
    const empty = mkdtempSync(path.join(tmpdir(), 'cara7-empty-'));
    await expect(codeFromWasmDir(deployContext(operator, network), empty)).rejects.toThrow(/is not readable/);
    expect(network.submitted).toHaveLength(0);
  });

  it('reuses the code of a deal only when the deal runs the new contract code', async () => {
    const { operator, network } = fakeServices();
    const [deal, note, agent] = [contract(), contract(), contract()];
    const hashes = new Map([
      [deal, Buffer.alloc(32, 1)],
      [note, Buffer.alloc(32, 2)],
      [agent, Buffer.alloc(32, 3)],
    ]);
    const newCode: DeployContext['read'] = async (_contractId, method) => {
      if (method === 'get_required_reserve') return 0n;
      if (method === 'get_wiring') return { note_tokens: [note], paying_agent: agent };
      if (method === 'controller') return deal;
      throw new Error(`Simulation failed (${method})`);
    };
    const context = deployContext(operator, network, {
      read: newCode,
      codeHashOf: async (contractId) => hashes.get(contractId) ?? Buffer.alloc(32),
    });
    expect(await codeFromDeal(context, deal)).toEqual({
      deal: Buffer.alloc(32, 1),
      note: Buffer.alloc(32, 2),
      agent: Buffer.alloc(32, 3),
    });
    // A deal of an earlier code (reference deal, Series 2, Series 4) has no `get_required_reserve`.
    const oldDeal: DeployContext['read'] = async (contractId, method) =>
      method === 'get_required_reserve' ? Promise.reject(new Error('Simulation failed')) : newCode(contractId, method);
    await expect(codeFromDeal({ ...context, read: oldDeal }, deal)).rejects.toThrow(
      /does not run the abs-deal code of the rank engine/,
    );
    const oldNote: DeployContext['read'] = async (contractId, method) =>
      method === 'controller' ? Promise.reject(new Error('Simulation failed')) : newCode(contractId, method);
    await expect(codeFromDeal({ ...context, read: oldNote }, deal)).rejects.toThrow(/does not run the new note-token code/);
    expect(network.submitted).toHaveLength(0);
  });

  it('signs each deploy with the crank and sends it as a Soroban transaction', async () => {
    const { operator, network } = fakeServices();
    const crank = await operator.resolve('crank');
    const request = deployRequest('deploy-deal', crank.address, Buffer.alloc(32, 7), [xdr.ScVal.scvU32(1)]);
    expect(request.role).toBe('crank');

    const operation = await operator.run(request);

    expect(operation.status).toBe('done');
    expect(StrKey.isValidContract(String(operation.result))).toBe(true);
    expect(network.submitted).toHaveLength(1);
    expect(network.submitted[0]).toMatchObject({ kind: 'contract', method: 'deploy', args: [1] });
    expect(network.submitted[0]?.transaction.source).toBe(crank.address);
  });
});

describe('deal:deploy with fakes, from the config to the registry', () => {
  it('uploads, deploys, wires, sets the whitelist and registers, in this order', async () => {
    const eligible = Array.from({ length: 21 }, account);
    const raw = rawConfig({ eligible });
    const { dir, config } = workspace(raw);
    const { operator, network, custody } = fakeServices();
    const posts: { pathname: string; body: unknown }[] = [];
    const post = async (pathname: string, body: unknown): Promise<unknown> => {
      posts.push({ pathname, body });
      return pathname === '/api/deals' ? { deal: { id: 7 } } : { tranche: { id: 1 } };
    };
    const context = deployContext(operator, network, { post });

    const result = await deployDeal(options(config, dir, 'http://registry'), context);

    const deploys = Array.from({ length: 6 }, () => 'deploy');
    expect(network.methods()).toEqual(['upload', 'upload', 'upload', ...deploys, 'set_wiring', 'set_eligible', 'set_eligible']);
    const crankCalls = network.submitted.slice(0, 9);
    const adminCalls = network.submitted.slice(9);
    for (const entry of crankCalls) expect(entry.transaction.source).toBe(custody.address('crank'));
    for (const entry of adminCalls) expect(entry.transaction.source).toBe(custody.address('admin'));

    const [dealDeploy, ...rest] = network.submitted.slice(3, 9);
    expect(dealDeploy?.args[0]).toMatchObject({
      admin: custody.address('admin'),
      servicer: custody.address('servicer'),
      asset: TEST_EURC.sac,
      seller: raw.seller,
      fees: [{ recipient: raw.feesRecipient, amount: ['Fixed', 1_000_000n] }],
    });
    const noteDeploys = rest.slice(0, 4);
    expect(noteDeploys.map((entry) => entry.args[2])).toEqual(['CARA7A9', 'CARA7B9', 'CARA7C9', 'JRD9']);
    for (const entry of noteDeploys) expect(entry.args).toMatchObject([result.deal, expect.any(String), expect.any(String), 100_000_000n]);
    expect(rest[4]?.args).toEqual([result.deal, TEST_EURC.sac, result.notes]);
    expect(adminCalls[0]).toMatchObject({ contractId: result.deal, args: [result.notes, result.payingAgent] });
    expect(adminCalls[1]?.args).toEqual([eligible.slice(0, 20), true]);
    expect(adminCalls[2]?.args).toEqual([eligible.slice(20), true]);

    expect(result).toMatchObject({ registryDealId: 7, registryError: null });
    // The record of the deploy: the roles, the code hashes and each transaction.
    expect(result.roles).toEqual({
      crank: custody.address('crank'),
      admin: custody.address('admin'),
      servicer: custody.address('servicer'),
      reporter: network.oracleReporter,
    });
    expect(result.transactions.map((entry) => entry.kind)).toEqual([
      'upload-deal',
      'upload-note',
      'upload-agent',
      'deploy-deal',
      'deploy-note-A',
      'deploy-note-B',
      'deploy-note-C',
      'deploy-note-D',
      'deploy-paying-agent',
      'set-wiring',
      'set-eligible',
      'set-eligible',
    ]);
    expect(result.transactions.map((entry) => entry.hash)).toEqual(
      network.submitted.map((entry) => entry.transaction.hash().toString('hex')),
    );
    const record = deployRecord(result, options(config, dir, 'http://registry'));
    expect(record).toMatchObject({
      configFile: 'deal.json',
      deal: result.deal,
      payingAgent: result.payingAgent,
      initialReserve: '50000000',
      registryDealId: 7,
    });
    expect(JSON.stringify(record)).not.toMatch(/"S[A-Z2-7]{55}"/);
    expect(posts.map((entry) => entry.pathname)).toEqual([
      '/api/deals',
      ...Array.from({ length: 4 }, () => '/api/deals/7/tranches'),
    ]);
    expect(posts[0]?.body).toMatchObject({
      name: 'Test deal (Series 9)',
      dealContractId: result.deal,
      payingAgentContractId: result.payingAgent,
      periodDays: 90,
    });
    expect(posts[4]?.body).toMatchObject({ classIndex: 3, contractId: result.notes[3], couponBps: 400, assetDecimals: 7 });
  });

  it('keeps the deal on chain when the registry fails, and gives the reason', async () => {
    const { dir, config } = workspace();
    const { operator, network } = fakeServices();
    const post = async (): Promise<unknown> => {
      throw new Error('POST /api/deals answered 500: down');
    };
    const result = await deployDeal(options(config, dir, 'http://registry'), deployContext(operator, network, { post }));
    expect(StrKey.isValidContract(result.deal)).toBe(true);
    expect(result).toMatchObject({ registryDealId: null, registryError: 'POST /api/deals answered 500: down' });
  });

  it('refuses before any transaction: another network, a template, an asset contract with another name', async () => {
    const { dir, config } = workspace();
    const { operator, network } = fakeServices();
    const onPublic = deployContext(operator, network, { networkPassphrase: Networks.PUBLIC });
    await expect(deployDeal(options(config, dir), onPublic)).rejects.toThrow(/is for testnet, but this backend uses/);
    const template = workspace(rawConfig({ seller: '<FILL: the seller>' }));
    await expect(deployDeal(options(template.config, dir), deployContext(operator, network))).rejects.toThrow(
      /is a template/,
    );
    network.assetName = `EURC:${account()}`;
    await expect(deployDeal(options(config, dir), deployContext(operator, network))).rejects.toThrow(/has the name/);
    expect(network.submitted).toHaveLength(0);
  });

  it('refuses a role conflict before any transaction', async () => {
    const { dir, config } = workspace();
    const { operator, network, custody } = fakeServices();
    // The reporter of the oracle is the admin wallet, then the servicer wallet.
    for (const role of ['admin', 'servicer'] as const) {
      network.oracleReporter = custody.address(role);
      await expect(deployDeal(options(config, dir), deployContext(operator, network))).rejects.toThrow(
        new RegExp(`The reporter of the oracle C[A-Z2-7]{55} is the ${role} wallet`),
      );
    }
    // The oracle does not name its reporter.
    network.oracleReporter = null;
    await expect(deployDeal(options(config, dir), deployContext(operator, network))).rejects.toThrow(
      /does not name its reporter/,
    );
    expect(network.submitted).toHaveLength(0);

    // One address as admin and servicer.
    const terms = termsOf();
    const same = account();
    await expect(checkRoles({ read: network.read.bind(network) }, terms, { admin: same, servicer: same })).rejects.toThrow(
      /the two roles are separate/,
    );
  });

  it('does not read the oracle for a deal with fixed rates only', async () => {
    const fixed = rawConfig({
      classes: [{ letter: 'A', label: 'SENIOR', rate: { kind: 'fixed', ratePct: '2.00' }, notes: 5 }],
    });
    const { dir, config } = workspace(fixed);
    const { operator, network } = fakeServices();
    network.oracleReporter = null;
    const result = await deployDeal(options(config, dir), deployContext(operator, network));
    expect(result.roles.reporter).toBeNull();
    expect(StrKey.isValidContract(result.deal)).toBe(true);
  });

  it('deploys the pro rata deal file with its whole structure', async () => {
    const template = JSON.parse(readFileSync(path.join(projectRoot, 'deals', 'd1-prorata.testnet.json'), 'utf8')) as {
      seller: string;
      eligible: string[];
      waterfall: { fees: { recipient: string }[] };
    };
    template.seller = account();
    template.eligible = [account(), account(), account()];
    for (const line of template.waterfall.fees) line.recipient = account();
    const { dir, config } = workspace(template as unknown as Record<string, unknown>);
    expect(loadDealConfig(config).waterfall.triggers).toHaveLength(1);
    const { operator, network } = fakeServices();
    const result = await deployDeal(options(config, dir), deployContext(operator, network));
    const constructorArg = network.submitted.find((entry) => entry.method === 'deploy')?.args[0];
    const onChain = decodeDealConfig(constructorArg);
    expect(onChain.normal.map((entry) => entry.id)).toEqual([
      'fees', 'int_a', 'int_b', 'reserve', 'int_c', 'prin_pr', 'prin_seq', 'residual',
    ]);
    expect(onChain.reserve.release).toBe('onNeed');
    // 5 % of 1,000, above the floor of 20.
    expect(result.terms.initialReserve).toBe(500_000_000n);
  });

  it('names the contracts on chain when a later step fails', async () => {
    const { dir, config } = workspace();
    const { operator, network } = fakeServices({ admin: 'reject' });
    const failure = deployDeal(options(config, dir), deployContext(operator, network));
    await expect(failure).rejects.toThrow(/rejected the signature/);
    await expect(failure).rejects.toThrow(/On chain so far: deal C[A-Z2-7]{55}\nnote tokens C.*\npaying agent C/);
    expect(network.methods().at(-1)).toBe('deploy');
  });
});
