import { createHash, randomBytes } from 'node:crypto';
import {
  Account,
  Address,
  Keypair,
  StrKey,
  TransactionBuilder,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { environment } from '../../src/config.js';
import { Operator } from '../../src/custody/operator.js';
import type {
  ChainOutcome,
  OperatorCustody,
  OperatorRole,
  RoleWallet,
  SignatureInput,
  SignatureState,
  StellarNetwork,
} from '../../src/custody/ports.js';
import type { OperatorServices } from '../../src/custody/services.js';

/**
 * Offline fakes of the two custody ports. The fake custody signs with
 * keypairs that it makes itself. No test reads a Stellar secret.
 */
export type SigningMode = 'auto' | 'approval' | 'tamper' | 'reject';

const passphrase = environment.NETWORK_PASSPHRASE;

interface FakeRequest {
  role: OperatorRole;
  transaction: Transaction;
  state: SignatureState;
}

export class FakeCustody implements OperatorCustody {
  readonly keypairs: Record<OperatorRole, Keypair> = {
    admin: Keypair.random(),
    servicer: Keypair.random(),
    reporter: Keypair.random(),
    crank: Keypair.random(),
  };
  readonly externalIds: string[] = [];
  private readonly requests = new Map<string, FakeRequest>();
  private counter = 0;

  constructor(readonly modes: Partial<Record<OperatorRole, SigningMode>> = {}) {}

  address(role: OperatorRole): string {
    return this.keypairs[role].publicKey();
  }

  async resolveRole(role: OperatorRole): Promise<RoleWallet> {
    return { walletId: `wa-${role}`, keyId: `key-${role}`, address: this.address(role) };
  }

  async requestSignature(input: SignatureInput): Promise<SignatureState> {
    this.counter += 1;
    const signatureId = `sig-${this.counter}`;
    this.externalIds.push(input.externalId ?? '');
    const state = this.firstState(signatureId, input);
    this.requests.set(signatureId, { role: input.role, transaction: input.transaction, state });
    return state;
  }

  async refreshSignature(_role: OperatorRole, signatureId: string): Promise<SignatureState> {
    return this.request(signatureId).state;
  }

  /** The person approves in app.dfns.io: the next refresh gives the signature. */
  approve(signatureId: string): void {
    const request = this.request(signatureId);
    const signedXdr = this.sign(request.role, request.transaction);
    request.state = { ...request.state, status: 'signed', signedXdr };
  }

  reject(signatureId: string, reason: string): void {
    const request = this.request(signatureId);
    request.state = { ...request.state, status: 'rejected', reason };
  }

  private firstState(signatureId: string, input: SignatureInput): SignatureState {
    switch (this.modes[input.role] ?? 'auto') {
      case 'auto': {
        const signedXdr = this.sign(input.role, input.transaction);
        return { signatureId, status: 'signed', signedXdr };
      }
      case 'tamper': {
        const signedXdr = this.tampered(input.role, input.transaction);
        return { signatureId, status: 'signed', signedXdr };
      }
      case 'reject':
        return { signatureId, status: 'rejected', reason: 'Blocked by the policy of the wallet.' };
      case 'approval':
        return { signatureId, status: 'pending', approvalId: `ap-${this.counter}` };
    }
  }

  private request(signatureId: string): FakeRequest {
    const request = this.requests.get(signatureId);
    if (!request) throw new Error(`The fake custody has no request ${signatureId}.`);
    return request;
  }

  private sign(role: OperatorRole, transaction: Transaction): string {
    const copy = TransactionBuilder.fromXDR(transaction.toXDR(), passphrase) as Transaction;
    copy.sign(this.keypairs[role]);
    return copy.toXDR();
  }

  /** A provider that changes the body: same transaction, higher fee. */
  private tampered(role: OperatorRole, transaction: Transaction): string {
    const envelope = xdr.TransactionEnvelope.fromXDR(transaction.toXDR(), 'base64');
    const body = envelope.v1().tx();
    body.fee(body.fee() + 1000);
    const changed = TransactionBuilder.fromXDR(envelope.toXDR('base64'), passphrase) as Transaction;
    changed.sign(this.keypairs[role]);
    return changed.toXDR();
  }
}

export interface Submitted {
  kind: 'contract' | 'classic';
  transaction: Transaction;
  /** The contract of a contract call. Null for a deploy, an upload or a classic operation. */
  contractId: string | null;
  method: string;
  args: unknown[];
  /** The wasm of an upload. */
  wasm?: Buffer;
}

/** The CARA7 test EURC: its SAC id matches its name on the test network. */
export const TEST_EURC = {
  sac: 'CBEO2RDQKBM7S3TYOYKBWAJEC6WMYPCW6JJWX47UCLFMUJI2EUZPJOXW',
  name: 'EURC:GCB6FLVHX7OXWSUHP76WGPVOJLGPB6FGXAQKMVSWPNP6NFUWNOHQMXQA',
};

export interface FakeDealOptions {
  /** The class count of the deal. The default is 3. */
  classCount?: number;
  /** The decimals of the settlement asset. The default is 7. */
  decimals?: number;
}

/**
 * A small in-memory deal: phase, next period, wiring, settlement asset and
 * the paying agent allocations. `read` ignores the contract id, except
 * that the answers of the deal and of its asset have distinct methods.
 */
export class FakeNetwork implements StellarNetwork {
  readonly submitted: Submitted[] = [];
  phase = 'Funding';
  nextPeriod = 3;
  classCount: number;
  wired = true;
  /** The settlement asset of the deal and what its contract says. */
  asset = TEST_EURC.sac;
  assetName = TEST_EURC.name;
  assetSymbol = 'EURC';
  assetDecimals: number;
  /** The paying agent of the deal wiring. It is not PAYING_AGENT_CONTRACT_ID. */
  readonly payingAgent = StrKey.encodeContract(randomBytes(32));
  /** The reporter that the oracle names. Null: the oracle has no `get_reporter`. */
  oracleReporter: string | null = Keypair.random().publicKey();
  private readonly allocs = new Map<string, boolean>();
  private readonly sequences = new Map<string, bigint>();

  constructor(options: FakeDealOptions = {}) {
    this.classCount = options.classCount ?? 3;
    this.assetDecimals = options.decimals ?? 7;
  }

  noteTokens(): string[] {
    return Array.from({ length: this.classCount }, (_value, index) =>
      StrKey.encodeContract(Buffer.alloc(32, index + 1)),
    );
  }

  async sourceAccount(address: string): Promise<Account> {
    return new Account(address, String(this.sequences.get(address) ?? 100n));
  }

  async prepare(transaction: Transaction): Promise<Transaction> {
    return transaction;
  }

  async read(_contractId: string, method: string, args: xdr.ScVal[] = []): Promise<unknown> {
    const values = args.map((arg) => scValToNative(arg) as unknown);
    switch (method) {
      case 'get_state':
        return this.phase;
      case 'get_next_period':
        return this.nextPeriod;
      case 'get_note_factors':
        return Array.from({ length: this.classCount }, () => 10_000_000n);
      case 'get_config':
        return { asset: this.asset };
      case 'get_wiring':
        return this.wired ? { note_tokens: this.noteTokens(), paying_agent: this.payingAgent } : null;
      case 'get_reporter':
        if (this.oracleReporter === null) throw new Error('Simulation failed (get_reporter)');
        return this.oracleReporter;
      case 'name':
        return this.assetName;
      case 'symbol':
        return this.assetSymbol;
      case 'decimals':
        return this.assetDecimals;
      case 'get_alloc': {
        const done = this.allocs.get(`${String(values[0])}:${String(values[1])}`);
        return done === undefined ? null : { done };
      }
      default:
        throw new Error(`The fake network has no answer for ${method}.`);
    }
  }

  async submitContractCall(signed: Transaction): Promise<ChainOutcome> {
    const call = this.record('contract', signed);
    return { hash: signed.hash().toString('hex'), result: this.apply(call) };
  }

  async submitClassic(signed: Transaction): Promise<ChainOutcome> {
    this.record('classic', signed);
    return { hash: signed.hash().toString('hex'), result: null };
  }

  methods(): string[] {
    return this.submitted.map((entry) => entry.method);
  }

  private record(kind: Submitted['kind'], signed: Transaction): Submitted {
    if (signed.signatures.length === 0) {
      throw new Error('The fake network refuses an unsigned transaction.');
    }
    const operation = signed.operations[0];
    const entry: Submitted = {
      kind,
      transaction: signed,
      contractId: null,
      method: operation?.type ?? 'none',
      args: [],
    };
    if (operation?.type === 'invokeHostFunction') {
      const hostFunction = operation.func;
      const type = hostFunction.switch().name;
      if (type === 'hostFunctionTypeInvokeContract') {
        const invocation = hostFunction.invokeContract();
        entry.contractId = Address.fromScAddress(invocation.contractAddress()).toString();
        entry.method = invocation.functionName().toString();
        entry.args = invocation.args().map((arg) => scValToNative(arg) as unknown);
      } else if (type === 'hostFunctionTypeUploadContractWasm') {
        entry.method = 'upload';
        entry.wasm = Buffer.from(hostFunction.wasm());
      } else {
        entry.method = 'deploy';
        entry.args = hostFunction.createContractV2().constructorArgs().map((arg) => scValToNative(arg) as unknown);
      }
    }
    this.submitted.push(entry);
    this.sequences.set(signed.source, BigInt(signed.sequence));
    return entry;
  }

  private apply(call: Submitted): unknown {
    if (call.method === 'deploy') return StrKey.encodeContract(randomBytes(32));
    // An upload returns the code hash: the SHA-256 of the wasm.
    if (call.method === 'upload') return createHash('sha256').update(call.wasm ?? Buffer.alloc(0)).digest();
    if (call.method === 'close') this.phase = 'Amortizing';
    if (call.method === 'distribute') {
      for (let classIndex = 0; classIndex < this.classCount; classIndex++) {
        this.allocs.set(`${String(call.args[0])}:${classIndex}`, false);
      }
      this.nextPeriod += 1;
      return Array.from({ length: this.classCount }, (_value, index) => BigInt(index + 1));
    }
    if (call.method === 'push_batch') {
      this.allocs.set(`${String(call.args[0])}:${String(call.args[1])}`, true);
      return 10;
    }
    return null;
  }
}

export function fakeServices(
  modes: Partial<Record<OperatorRole, SigningMode>> = {},
  deal: FakeDealOptions = {},
): {
  custody: FakeCustody;
  network: FakeNetwork;
  operator: Operator;
  services: OperatorServices;
} {
  const custody = new FakeCustody(modes);
  const network = new FakeNetwork(deal);
  const operator = new Operator({ custody, network, networkPassphrase: passphrase });
  return { custody, network, operator, services: { network, operator } };
}
