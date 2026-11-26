import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Asset, Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  formatUnits,
  isWholeMultiple,
  numberToBaseUnits,
  percentToRateUnits,
  rateUnitsToBps,
  toBaseUnits,
  toDisplayNumber,
} from '../src/deals/amounts.js';
import {
  DEAL_NETWORKS,
  NETWORK_PASSPHRASE,
  SETTLEMENT_ASSETS,
  networkOfPassphrase,
  settlementAsset,
} from '../src/deals/assets.js';
import {
  DealConfigError,
  findPlaceholders,
  loadDealConfig,
  parseDealConfig,
  resolveDealTerms,
} from '../src/deals/config.js';
import { referenceOrders } from '../src/deals/onchain.js';
import { projectRoot } from '../src/paths.js';
import { TEST_EURC } from './support/fakes.js';

const contract = (): string => StrKey.encodeContract(Keypair.random().rawPublicKey());
const account = (): string => Keypair.random().publicKey();
const CIRCLE_TESTNET = 'CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ';

describe('settlement assets', () => {
  it('lists for each asset the SAC id of that asset on its network', () => {
    for (const network of DEAL_NETWORKS) {
      for (const asset of SETTLEMENT_ASSETS[network]) {
        const sac = new Asset(asset.code, asset.issuer).contractId(NETWORK_PASSPHRASE[network]);
        expect(sac, `${network} ${asset.label}`).toBe(asset.sac);
      }
    }
  });

  it('refuses an asset that is not in the list of the network', () => {
    expect(settlementAsset('testnet', CIRCLE_TESTNET).label).toMatch(/Circle EURC/);
    expect(() => settlementAsset('mainnet', CIRCLE_TESTNET)).toThrow(/not a settlement asset of mainnet/);
    expect(networkOfPassphrase(NETWORK_PASSPHRASE.mainnet)).toBe('mainnet');
    expect(networkOfPassphrase('Standalone Network ; February 2017')).toBeNull();
  });
});

describe('decimal amounts', () => {
  it('converts decimal strings to base units without floats', () => {
    expect(toBaseUnits('10', 7)).toBe(100_000_000n);
    expect(toBaseUnits('0.01', 7)).toBe(100_000n);
    expect(toBaseUnits('1.0000001', 7)).toBe(10_000_001n);
    expect(toBaseUnits('12.5', 6)).toBe(12_500_000n);
    expect(toBaseUnits('7', 0)).toBe(7n);
    expect(() => toBaseUnits('1.00000001', 7, 'reserve')).toThrow('reserve "1.00000001" has more than 7 decimals.');
    expect(() => toBaseUnits('-1', 7)).toThrow(/not a decimal amount/);
    expect(() => toBaseUnits('1e3', 7)).toThrow(/not a decimal amount/);
    expect(() => toBaseUnits(' 1', 7)).toThrow(/not a decimal amount/);
  });

  it('formats base units back, and gives exact numbers to the views', () => {
    expect(formatUnits(125_000_000n, 7)).toBe('12.5');
    expect(formatUnits(1n, 7)).toBe('0.0000001');
    expect(formatUnits(-5n, 2)).toBe('-0.05');
    expect(formatUnits(42n, 0)).toBe('42');
    expect(toDisplayNumber(1n, 6)).toBe(0.000001);
  });

  it('rounds an older JSON number to the asset decimals', () => {
    expect(numberToBaseUnits(12.5, 7)).toBe(125_000_000n);
    expect(numberToBaseUnits(0.1 + 0.2, 7)).toBe(3_000_000n);
    expect(() => numberToBaseUnits(-1, 7)).toThrow(/not an amount/);
    expect(() => numberToBaseUnits(Number.NaN, 7)).toThrow(/not an amount/);
  });

  it('turns percents into rate units of 0.001 % and basis points', () => {
    expect(percentToRateUnits('0.60')).toBe(600n);
    expect(percentToRateUnits('1.5')).toBe(1500n);
    expect(percentToRateUnits('4.00')).toBe(4000n);
    expect(percentToRateUnits('0.605')).toBe(605n);
    expect(() => percentToRateUnits('0.6055')).toThrow(/more than 3 decimals/);
    expect(rateUnitsToBps(600n)).toBe(60);
    expect(() => rateUnitsToBps(605n)).toThrow(/0.605 % is not a whole number of basis points/);
  });

  it('compares a denomination with a rounding unit exactly', () => {
    expect(isWholeMultiple('10', '0.01')).toBe(true);
    expect(isWholeMultiple('100.05', '0.01')).toBe(true);
    expect(isWholeMultiple('10.005', '0.01')).toBe(false);
    expect(isWholeMultiple('10', '0')).toBe(false);
  });
});

function validConfig(): Record<string, unknown> {
  return {
    version: 1,
    network: 'testnet',
    name: 'Test deal',
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
      { letter: 'B', label: 'JUNIOR', rate: { kind: 'fixed', ratePct: '1.50' }, notes: 3, name: 'B notes', symbol: 'TESTB' },
    ],
    eligible: [account()],
  };
}

function classes(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_value, index) => ({
    letter: String.fromCharCode(65 + index),
    label: 'SENIOR',
    rate: { kind: 'fixed', ratePct: '1' },
    notes: 1,
  }));
}

function issues(raw: Record<string, unknown>): string {
  try {
    parseDealConfig(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(DealConfigError);
    return (error as Error).message;
  }
  throw new Error('The config passed the validation.');
}

describe('deal config, version 1', () => {
  it('converts the amounts with the asset decimals and the rates to 0.001 % units', () => {
    const config = parseDealConfig(validConfig());
    const terms = resolveDealTerms(config, 7);
    expect(terms).toMatchObject({
      decimals: 7,
      denomination: 100_000_000n,
      roundUnit: 100_000n,
      initialReserve: 50_000_000n,
    });
    expect(terms.asset.label).toMatch(/CARA7 test EURC/);
    expect(terms.classes).toEqual([
      {
        index: 0,
        letter: 'A',
        label: 'SENIOR',
        rate: { kind: 'floating', units: 600n },
        // A version 1 file floors the all-in rate of a floating class at 0 %.
        floor: 0n,
        indexFloor: null,
        notes: 4n,
        name: 'CARA7 Series 9 Class A Notes',
        symbol: 'CARA7A9',
      },
      {
        index: 1,
        letter: 'B',
        label: 'JUNIOR',
        rate: { kind: 'fixed', units: 1500n },
        floor: null,
        indexFloor: null,
        notes: 3n,
        name: 'B notes',
        symbol: 'TESTB',
      },
    ]);
    // A version 1 file has the reference order: one fixed fee line, a fixed
    // reserve released in full, no trigger.
    expect(terms.waterfall).toEqual({
      fees: [{ recipient: config.waterfall.fees[0]?.recipient, amount: { kind: 'fixed', amount: 1_000_000n } }],
      reserve: { required: { kind: 'fixed', amount: 50_000_000n }, release: 'full', drawRanks: [] },
      triggers: [],
      ...referenceOrders(2),
    });
    expect(resolveDealTerms(config, 2).denomination).toBe(1_000n);
    expect(() => resolveDealTerms(config, 1)).toThrow('roundUnit "0.01" has more than 1 decimals.');
  });

  it('accepts 1 to 8 classes with distinct letters and a positive note count', () => {
    expect(parseDealConfig({ ...validConfig(), classes: classes(8) }).classes).toHaveLength(8);
    expect(issues({ ...validConfig(), classes: [] })).toMatch(/classes/);
    expect(issues({ ...validConfig(), classes: classes(9) })).toMatch(/classes/);
    const twice = classes(2).map((terms) => ({ ...terms, letter: 'A' }));
    expect(issues({ ...validConfig(), classes: twice })).toMatch(/classes\[1\]\.letter: the letter A is already used/);
    const none = classes(1).map((terms) => ({ ...terms, notes: 0 }));
    expect(issues({ ...validConfig(), classes: none })).toMatch(/classes\[0\]\.notes/);
    const fraction = classes(1).map((terms) => ({ ...terms, notes: 1.5 }));
    expect(issues({ ...validConfig(), classes: fraction })).toMatch(/classes\[0\]\.notes/);
  });

  it('needs a denomination that is a whole multiple of the rounding unit', () => {
    expect(issues({ ...validConfig(), denomination: '10.005' })).toMatch(/denomination: a whole multiple of roundUnit/);
    expect(issues({ ...validConfig(), roundUnit: '0' })).toMatch(/roundUnit: more than 0 expected/);
    expect(issues({ ...validConfig(), denomination: '0' })).toMatch(/denomination: more than 0 expected/);
  });

  it('checks every address and the settlement asset of the network', () => {
    expect(issues({ ...validConfig(), seller: contract() })).toMatch(/seller: an account address/);
    expect(issues({ ...validConfig(), oracle: account() })).toMatch(/oracle: a contract address/);
    expect(issues({ ...validConfig(), eligible: ['GABC'] })).toMatch(/eligible\[0\]: an account address/);
    const holder = account();
    expect(issues({ ...validConfig(), eligible: [holder, holder] })).toMatch(/eligible\[1\]: .* in the list twice/);
    expect(issues({ ...validConfig(), asset: contract() })).toMatch(/asset: not a settlement asset of testnet/);
    expect(issues({ ...validConfig(), network: 'mainnet' })).toMatch(/asset: not a settlement asset of mainnet/);
  });

  it('refuses unknown fields, another version and another currency', () => {
    expect(issues({ ...validConfig(), version: 3 })).toMatch(/version: 1 or 2 expected/);
    // A version 2 file has a waterfall block, and no reserve, feesPerPeriod or feesRecipient.
    expect(issues({ ...validConfig(), version: 2 })).toMatch(/waterfall/);
    expect(issues({ ...validConfig(), denominationCurrency: 'USD' })).toMatch(/denominationCurrency/);
    expect(issues({ ...validConfig(), extra: true })).toMatch(/extra/);
    expect(issues({ ...validConfig(), reserve: 5 })).toMatch(/reserve/);
  });

  it('refuses a template and names each placeholder', () => {
    const raw = { ...validConfig(), oracle: '<FILL: the oracle>', eligible: ['<FILL: an investor>'] };
    expect(findPlaceholders(raw)).toEqual([
      { path: 'oracle', value: '<FILL: the oracle>' },
      { path: 'eligible[0]', value: '<FILL: an investor>' },
    ]);
    const message = issues(raw);
    expect(message).toMatch(/is a template/);
    expect(message).toContain('oracle: <FILL: the oracle>');
    expect(message).toContain('eligible[0]: <FILL: an investor>');
  });
});

/** Fills each placeholder as the runbook does: a contract for the oracle, an account elsewhere. */
function filled(value: unknown, key = ''): unknown {
  if (typeof value === 'string' && /^<[\s\S]*>$/.test(value)) return key === 'oracle' ? contract() : account();
  if (Array.isArray(value)) return value.map((item) => filled(item, key));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, filled(item, name)]));
  }
  return value;
}

describe('the deal config files in deals/', () => {
  const file = (name: string): string => path.join(projectRoot, 'deals', name);
  const raw = (name: string): unknown => JSON.parse(readFileSync(file(name), 'utf8'));
  const placeholders = (name: string): string[] => findPlaceholders(raw(name)).map((entry) => entry.path);

  it('keeps the files of the testnet runs as templates until a run fills the placeholders', () => {
    for (const name of ['d2-demo.testnet.json', 'd1-prorata.testnet.json', 'custody-demo.testnet.json']) {
      expect(() => loadDealConfig(file(name)), name).toThrow(/is a template/);
    }
    expect(placeholders('d2-demo.testnet.json')).toEqual(['seller', 'eligible[0]', 'waterfall.fees[0].recipient']);
    expect(placeholders('d1-prorata.testnet.json')).toEqual([
      'seller',
      'eligible[0]',
      'waterfall.fees[0].recipient',
      'waterfall.fees[1].recipient',
    ]);
    expect(placeholders('custody-demo.testnet.json')).toEqual(['oracle', 'eligible[1]', 'eligible[2]']);
  });

  it('loads the Series 4 file: a deployed deal, with an empty initial whitelist', () => {
    expect(placeholders('series-4.testnet.json')).toEqual([]);
    const config = loadDealConfig(file('series-4.testnet.json'));
    expect(config.eligible).toEqual([]);
    expect(config.version).toBe(2);
  });

  it('gives the D2 demo terms: Circle testnet EURC, 4 classes and the reference order', () => {
    const terms = resolveDealTerms(parseDealConfig(filled(raw('d2-demo.testnet.json'))), 7);
    expect(terms.config.asset).toBe(CIRCLE_TESTNET);
    expect(terms).toMatchObject({
      denomination: 100_000_000n,
      roundUnit: 100_000n,
      initialReserve: 50_000_000n,
    });
    expect(terms.config.daysInPeriod).toBe(90);
    expect(terms.classes.map((plan) => [plan.letter, plan.rate.kind, plan.rate.units, plan.notes, plan.floor])).toEqual([
      ['A', 'floating', 600n, 4n, 0n],
      ['B', 'fixed', 1500n, 3n, null],
      ['C', 'fixed', 2500n, 2n, null],
      ['D', 'fixed', 4000n, 1n, null],
    ]);
    expect(terms.waterfall.fees.map((line) => line.amount)).toEqual([{ kind: 'fixed', amount: 1_000_000n }]);
    expect({ normal: terms.waterfall.normal, enforced: terms.waterfall.enforced }).toEqual(referenceOrders(4));
  });

  it('gives the pro rata demo terms: two fee lines, an on-need reserve and a latched trigger', () => {
    const terms = resolveDealTerms(parseDealConfig(filled(raw('d1-prorata.testnet.json'))), 7);
    expect(terms.config.asset).toBe(TEST_EURC.sac);
    // 5 % of the 1,000 of notes.
    expect(terms.initialReserve).toBe(500_000_000n);
    expect(terms.classes[0]).toMatchObject({ rate: { kind: 'floating', units: 700n }, floor: null, indexFloor: 0n });
    expect(terms.waterfall.fees.map((line) => line.amount)).toEqual([
      { kind: 'fixed', amount: 10_000_000n },
      { kind: 'perAnnum', rate: 1000n },
    ]);
    expect(terms.waterfall.reserve).toEqual({
      required: { kind: 'pctOfNotes', pct: 5000n, floor: 200_000_000n },
      release: 'onNeed',
      drawRanks: ['fees', 'int_a', 'int_b'],
    });
    // "50" is 50 % of the initial notes, in factor units.
    expect(terms.waterfall.triggers).toEqual([
      { id: 'seq', metric: { kind: 'notesFactor' }, op: 'lt', threshold: 5_000_000n, latch: true },
    ]);
    const principalRanks = terms.waterfall.normal.filter((entry) => entry.items[0]?.kind === 'principal');
    expect(principalRanks.map((entry) => [entry.id, entry.when, entry.alloc])).toEqual([
      ['prin_pr', { kind: 'notTrigger', id: 'seq' }, 'pariPassu'],
      ['prin_seq', { kind: 'trigger', id: 'seq' }, 'sequential'],
    ]);
  });

  it('gives the Series 4 terms: the CARA7 test EURC and the reference classes', () => {
    const terms = resolveDealTerms(parseDealConfig(raw('series-4.testnet.json')), 7);
    expect(terms.config).toMatchObject({
      asset: TEST_EURC.sac,
      series: '4',
      daysInPeriod: 30,
      oracle: 'CAAOMPQADAW34FU4VUXDUHS6RDF6SVGCTK4S2T2YONIKNQA22IBYA72X',
      seller: 'GCV6OX6GKQOJJGD3DTF5AIENK3EKR64OPHCNCX5MGZUT2KTDD5QGFFRI',
    });
    expect(terms).toMatchObject({
      denomination: 1_000_000_000n,
      roundUnit: 100_000n,
      initialReserve: 5_000_000_000n,
    });
    expect(terms.waterfall.fees).toEqual([
      {
        recipient: 'GCV6OX6GKQOJJGD3DTF5AIENK3EKR64OPHCNCX5MGZUT2KTDD5QGFFRI',
        amount: { kind: 'fixed', amount: 50_000_000n },
      },
    ]);
    expect(terms.classes.map((plan) => [plan.letter, plan.label, plan.rate.kind, plan.rate.units, plan.notes])).toEqual([
      ['A', 'SENIOR', 'floating', 600n, 100n],
      ['B', 'MEZZANINE', 'fixed', 1000n, 70n],
      ['C', 'JUNIOR', 'fixed', 1500n, 45n],
    ]);
  });

  it('gives the custody demo terms: notes of 100 on each side of the approval threshold of 250', () => {
    const terms = resolveDealTerms(parseDealConfig(filled(raw('custody-demo.testnet.json'))), 7);
    expect(terms.denomination).toBe(1_000_000_000n);
    expect(terms.initialReserve).toBe(1_000_000_000n);
    expect(terms.classes.map((plan) => plan.notes)).toEqual([10n, 5n, 3n]);
    expect({ normal: terms.waterfall.normal, enforced: terms.waterfall.enforced }).toEqual(referenceOrders(3));
  });
});

/** A valid version 2 config: the pro rata demo file with an address in each placeholder. */
function versionTwo(): {
  classes: { letter: string }[];
  waterfall: {
    fees: unknown[];
    reserve: { required: unknown; release: string; drawRanks: string[] };
    triggers: { id: string; metric: Record<string, unknown>; threshold: string }[];
    normal: { id: string; when?: unknown; alloc: string; items: Record<string, unknown>[] }[];
    enforced: { id: string; when?: unknown; alloc: string; items: Record<string, unknown>[] }[];
  };
  [key: string]: unknown;
} {
  const template = JSON.parse(readFileSync(path.join(projectRoot, 'deals', 'd1-prorata.testnet.json'), 'utf8')) as unknown;
  return filled(template) as ReturnType<typeof versionTwo>;
}

describe('deal config, version 2: the priority of payments', () => {
  it('accepts the pro rata demo structure', () => {
    expect(() => parseDealConfig(versionTwo())).not.toThrow();
  });

  it('refuses the fields of version 1', () => {
    expect(issues({ ...versionTwo(), reserve: '5' })).toMatch(/reserve/);
    expect(issues({ ...versionTwo(), feesRecipient: account() })).toMatch(/feesRecipient/);
  });

  it('names a class, a fee line or a trigger that the deal does not have', () => {
    const noClass = versionTwo();
    noClass.waterfall.normal[1] = { id: 'int_a', alloc: 'sequential', items: [{ kind: 'interest', class: 'Z' }] };
    expect(issues(noClass)).toMatch(/waterfall\.normal\[1\]\.items\[0\]\.class: the deal has no Class Z/);
    const noFee = versionTwo();
    noFee.waterfall.normal[0]?.items.push({ kind: 'fee', index: 2 });
    expect(issues(noFee)).toMatch(/waterfall\.normal\[0\]\.items\[2\]\.index: the deal has 2 fee line\(s\): no fee line 2/);
    const noTrigger = versionTwo();
    noTrigger.waterfall.triggers = [];
    expect(issues(noTrigger)).toMatch(/waterfall\.normal\[5\]\.when: the trigger "seq" is not in waterfall\.triggers/);
    const noMetricClass = versionTwo();
    noMetricClass.waterfall.triggers[0] = { id: 'seq', metric: { kind: 'classFactor', class: 'Z' }, threshold: '50' };
    expect(issues(noMetricClass)).toMatch(/waterfall\.triggers\[0\]/);
  });

  it('refuses an item that can run twice, or only under a condition', () => {
    const twice = versionTwo();
    const pariPassu = twice.waterfall.normal[5];
    if (!pariPassu) throw new Error('The demo structure has a rank 5.');
    delete pariPassu.when;
    expect(issues(twice)).toMatch(/the principal of Class A is in more than one rank that can run/);
    const conditional = versionTwo();
    conditional.waterfall.normal.splice(6, 1);
    expect(issues(conditional)).toMatch(/the principal of Class A runs only under a condition in the normal order/);
  });

  it('needs the interest and the principal of each class, and each fee line, in each order', () => {
    const noInterest = versionTwo();
    noInterest.waterfall.normal.splice(4, 1);
    expect(issues(noInterest)).toMatch(/the interest of Class C has no rank in the normal order/);
    const noFee = versionTwo();
    noFee.waterfall.enforced[0] = { id: 'fees', alloc: 'sequential', items: [{ kind: 'fee', index: 0 }] };
    expect(issues(noFee)).toMatch(/the fee 1 has no rank in the enforced order/);
  });

  it('ranks the interest of a class before its principal', () => {
    const config = versionTwo();
    const [interestC] = config.waterfall.normal.splice(4, 1);
    if (!interestC) throw new Error('The demo structure has a rank 4.');
    // After the two principal ranks, before the residual.
    config.waterfall.normal.splice(6, 0, interestC);
    expect(issues(config)).toMatch(/the interest of Class C ranks before its principal in the normal order/);
  });

  it('keeps the residual alone, last and with no condition', () => {
    const shared = versionTwo();
    shared.waterfall.normal.at(-1)?.items.unshift({ kind: 'reserveRefill' });
    expect(issues(shared)).toMatch(/the residual is alone in the last rank/);
    const none = versionTwo();
    none.waterfall.enforced.pop();
    expect(issues(none)).toMatch(/the residual has no rank in the enforced order/);
  });

  it('keeps one kind of item in a pari passu rank', () => {
    const config = versionTwo();
    config.waterfall.enforced[1] = {
      id: 'acc_a',
      alloc: 'pariPassu',
      items: [{ kind: 'interest', class: 'A' }, { kind: 'principal', class: 'A' }],
    };
    expect(issues(config)).toMatch(/waterfall\.enforced\[1\]\.alloc: a pari passu rank holds items of one kind/);
  });

  it('lets the reserve cover fee and interest ranks of the normal order only', () => {
    const principal = versionTwo();
    principal.waterfall.reserve.drawRanks = ['fees', 'prin_pr'];
    expect(issues(principal)).toMatch(/drawRanks\[1\]: the rank "prin_pr" holds an item that is not a fee or interest/);
    const unknown = versionTwo();
    unknown.waterfall.reserve.drawRanks = ['acc_a'];
    expect(issues(unknown)).toMatch(/drawRanks\[0\]: "acc_a" is not a rank of the normal order/);
    const full = versionTwo();
    full.waterfall.reserve.release = 'full';
    expect(issues(full)).toMatch(/a reserve released in full has no draw rank/);
  });

  it('needs a refill rank for a deal with a reserve', () => {
    const config = versionTwo();
    config.waterfall.normal.splice(3, 1);
    expect(issues(config)).toMatch(/a deal with a reserve needs a "reserveRefill" rank in the normal order/);
  });

  it('refuses a duplicate id and more than the limits of the contract', () => {
    const duplicate = versionTwo();
    const second = duplicate.waterfall.normal[2];
    if (!second) throw new Error('The demo structure has a rank 2.');
    second.id = 'int_a';
    expect(issues(duplicate)).toMatch(/waterfall\.normal\[2\]\.id: the id "int_a" is used twice in the normal order/);
    const fees = versionTwo();
    fees.waterfall.fees = Array.from({ length: 5 }, () => ({ recipient: account(), amount: { kind: 'fixed', amount: '1' } }));
    expect(issues(fees)).toMatch(/waterfall\.fees/);
    const longId = versionTwo();
    const first = longId.waterfall.normal[0];
    if (!first) throw new Error('The demo structure has a rank 0.');
    first.id = 'an_id_of_more_than_16_characters';
    expect(issues(longId)).toMatch(/waterfall\.normal\[0\]\.id/);
  });

  it('reads a threshold as a percent for a factor and as an amount for a shortfall', () => {
    const config = versionTwo();
    config.waterfall.triggers.push(
      { id: 'short', metric: { kind: 'classShortfall', class: 'B' }, op: 'gt', threshold: '0.50', latch: false } as never,
      { id: 'thin', metric: { kind: 'classFactor', class: 'A' }, op: 'le', threshold: '12.5', latch: false } as never,
    );
    const terms = resolveDealTerms(parseDealConfig(config), 7);
    expect(terms.waterfall.triggers.map((trigger) => [trigger.id, trigger.metric, trigger.threshold])).toEqual([
      ['seq', { kind: 'notesFactor' }, 5_000_000n],
      ['short', { kind: 'classShortfall', class: 1 }, 5_000_000n],
      ['thin', { kind: 'classFactor', class: 0 }, 1_250_000n],
    ]);
  });
});
