import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { PasskeyVerifier, StoredCredential, VerifiedPasskey } from '../src/auth/passkeys.js';
import type { CustodyProvider, CustodyWallet, SignatureState } from '../src/custody/port.js';
import type { AppLogger } from '../src/deps.js';
import { CustodyUnavailableError } from '../src/errors.js';
import { FundingError, type WalletFunder } from '../src/funding/friendbot.js';
import { loadPolicy, parsePolicy, type Policy } from '../src/policy/policy.js';
import { hexToBase64 } from '../src/signing/envelope.js';
import { MemoryStore } from '../src/store/memory.js';

export const POLICY: Policy = loadPolicy('testnet');
/// The same policy with a threshold of 200 EURC: 2 notes of 100 EURC are at the threshold.
export const POLICY_200: Policy = parsePolicy({ ...POLICY, thresholdEurc: '200' });

export const [DEAL, SERIES_2] = POLICY.deals as [Policy['deals'][number], Policy['deals'][number]];
export const NOTE_TOKEN = 'CBHFKNK7UK6YBVXZUWPOMY6LK44FZJSKWHPF4HJBUBV64KC455IJDROK';
export const OTHER_ISSUER = Keypair.random().publicKey();

/// 2026-11-02T12:00:00Z
export const NOW = new Date(Date.UTC(2026, 10, 2, 12, 0, 0));
export const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

export const silentLogger: AppLogger & { lines: string[] } = {
  lines: [],
  info(message) {
    this.lines.push(message);
  },
  error(message) {
    this.lines.push(message);
  },
};

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export type TxOptions = {
  source?: string;
  fee?: string;
  maxTime?: number;
  networkPassphrase?: string;
};

export function buildTx(wallet: string, operations: xdr.Operation[], options: TxOptions = {}): Transaction {
  const builder = new TransactionBuilder(new Account(options.source ?? wallet, '100'), {
    fee: options.fee ?? '100000',
    networkPassphrase: options.networkPassphrase ?? Networks.TESTNET,
  });
  for (const operation of operations) builder.addOperation(operation);
  return builder.setTimebounds(0, options.maxTime ?? NOW_SECONDS + 600).build();
}

export function addressArg(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

export function sourceAuth(contract: string, method: string, args: xdr.ScVal[]): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contract).toScAddress(),
          functionName: method,
          args,
        }),
      ),
      subInvocations: [],
    }),
  });
}

export function addressAuth(contract: string, method: string, args: xdr.ScVal[], signer: string): xdr.SorobanAuthorizationEntry {
  const entry = sourceAuth(contract, method, args);
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(signer).toScAddress(),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 1000,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: entry.rootInvocation(),
  });
}

type CallOptions = {
  contract?: string;
  auth?: 'source' | 'none' | xdr.SorobanAuthorizationEntry[];
  source?: string;
};

export function contractCall(contract: string, method: string, args: xdr.ScVal[], options: CallOptions = {}): xdr.Operation {
  const auth =
    options.auth === 'none'
      ? []
      : Array.isArray(options.auth)
        ? options.auth
        : [sourceAuth(contract, method, args)];
  return Operation.invokeContractFunction({
    contract,
    function: method,
    args,
    auth,
    ...(options.source ? { source: options.source } : {}),
  });
}

export function subscriptionArgs(investor: string, classIndex: number, notes: bigint): xdr.ScVal[] {
  return [
    addressArg(investor),
    nativeToScVal(classIndex, { type: 'u32' }),
    nativeToScVal(notes, { type: 'i128' }),
  ];
}

export function subscribeOp(investor: string, notes: bigint, options: CallOptions & { classIndex?: number } = {}): xdr.Operation {
  const contract = options.contract ?? DEAL.dealContractId;
  return contractCall(contract, 'subscribe', subscriptionArgs(investor, options.classIndex ?? 0, notes), options);
}

export function cancelOp(investor: string, notes: bigint, options: CallOptions = {}): xdr.Operation {
  const contract = options.contract ?? DEAL.dealContractId;
  return contractCall(contract, 'cancel', subscriptionArgs(investor, 1, notes), options);
}

export function claimOp(holder: string, options: CallOptions = {}): xdr.Operation {
  const contract = options.contract ?? DEAL.payingAgentContractId;
  return contractCall(contract, 'claim', [addressArg(holder)], options);
}

export function eurc(policy: Policy = POLICY): Asset {
  return new Asset(policy.eurc.code, policy.eurc.issuer);
}

export function changeTrustOp(asset: Asset, limit?: string): xdr.Operation {
  return Operation.changeTrust(limit === undefined ? { asset } : { asset, limit });
}

export function toBase64(transaction: Transaction | FeeBumpTransaction): string {
  return transaction.toEnvelope().toXDR('base64');
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type FakeSignature = { keyId: string; transactionHex: string; externalId: string; state: SignatureState };

/// A custody provider that signs with keys created inside the test.
export class FakeCustody implements CustodyProvider {
  readonly keys = new Map<string, { wallet: CustodyWallet; keypair: Keypair; tags: string[]; name: string }>();
  readonly signatures = new Map<string, FakeSignature>();
  failCreateWallet = false;
  failSignature = false;
  private counter = 0;

  async createWallet({ name, tags }: { name: string; tags: string[] }): Promise<CustodyWallet> {
    if (this.failCreateWallet) throw new CustodyUnavailableError('The custody provider could not create the wallet.');
    this.counter += 1;
    const keypair = Keypair.random();
    const wallet = { walletId: `wa-${this.counter}`, keyId: `key-${this.counter}`, address: keypair.publicKey() };
    this.keys.set(wallet.keyId, { wallet, keypair, tags, name });
    return wallet;
  }

  async getWallet(walletId: string): Promise<CustodyWallet> {
    const entry = [...this.keys.values()].find((candidate) => candidate.wallet.walletId === walletId);
    if (!entry) throw new CustodyUnavailableError('The custody provider could not read the wallet.');
    return entry.wallet;
  }

  async generateSignature(input: { keyId: string; transactionHex: string; externalId: string }): Promise<SignatureState> {
    if (this.failSignature) throw new CustodyUnavailableError('The custody provider could not start the signature request.');
    this.counter += 1;
    const state: SignatureState = { signatureId: `sig-${this.counter}`, status: 'Pending', approvalId: `ap-${this.counter}` };
    this.signatures.set(state.signatureId, { ...input, state });
    return { ...state };
  }

  async getSignature({ signatureId }: { keyId: string; signatureId: string }): Promise<SignatureState> {
    const signature = this.signatures.get(signatureId);
    if (!signature) throw new CustodyUnavailableError('The custody provider could not read the signature request.');
    return { ...signature.state };
  }

  keypairOf(address: string): Keypair {
    const entry = [...this.keys.values()].find((candidate) => candidate.wallet.address === address);
    if (!entry) throw new Error(`No fake wallet for ${address}`);
    return entry.keypair;
  }

  preparedTransaction(signatureId: string): Transaction {
    const signature = this.mustGet(signatureId);
    const base64 = hexToBase64(signature.transactionHex);
    if (base64 === null) throw new Error('The fake received bad hex.');
    return TransactionBuilder.fromXDR(base64, Networks.TESTNET) as Transaction;
  }

  /// Approves and signs the prepared body. `change` lets a test alter the body first.
  sign(signatureId: string, change?: (transaction: Transaction) => Transaction): void {
    const signature = this.mustGet(signatureId);
    const keypair = this.keys.get(signature.keyId)?.keypair;
    if (!keypair) throw new Error('Unknown fake key.');
    const prepared = this.preparedTransaction(signatureId);
    const transaction = change ? change(prepared) : prepared;
    transaction.sign(keypair);
    signature.state = {
      ...signature.state,
      status: 'Signed',
      signedData: `0x${transaction.toEnvelope().toXDR('hex')}`,
    };
  }

  setStatus(signatureId: string, status: 'Rejected' | 'Failed', reason?: string): void {
    const signature = this.mustGet(signatureId);
    signature.state = { ...signature.state, status, ...(reason ? { reason } : {}) };
  }

  private mustGet(signatureId: string): FakeSignature {
    const signature = this.signatures.get(signatureId);
    if (!signature) throw new Error(`Unknown fake signature ${signatureId}`);
    return signature;
  }
}

/// A WebAuthn fake: a response is valid when its clientDataJSON holds the challenge.
export class FakePasskeys implements PasskeyVerifier {
  private counter = 0;

  async registrationOptions({ displayName }: { displayName: string }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    this.counter += 1;
    return {
      challenge: `register-challenge-${this.counter}`,
      rp: { name: 'CARA7', id: 'localhost' },
      user: { id: `user-${this.counter}`, name: displayName, displayName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    };
  }

  async verifyRegistration(input: {
    response: { id: string; response: { clientDataJSON: string } };
    expectedChallenge: string;
  }): Promise<VerifiedPasskey | null> {
    if (input.response.response.clientDataJSON !== input.expectedChallenge) return null;
    return { credentialId: input.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] };
  }

  async authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    this.counter += 1;
    return { challenge: `login-challenge-${this.counter}`, rpId: 'localhost', userVerification: 'preferred' };
  }

  async verifyAuthentication(input: {
    response: { response: { clientDataJSON: string } };
    expectedChallenge: string;
    credential: StoredCredential;
  }): Promise<{ newCounter: number } | null> {
    if (input.response.response.clientDataJSON !== input.expectedChallenge) return null;
    return { newCounter: input.credential.counter + 1 };
  }
}

export class FakeFunder implements WalletFunder {
  readonly funded: string[] = [];
  fail = false;

  async fund(address: string): Promise<void> {
    if (this.fail) throw new FundingError('Friendbot answered HTTP 500.');
    this.funded.push(address);
  }
}

export type TestContext = {
  app: FastifyInstance;
  store: MemoryStore;
  custody: FakeCustody;
  funder: FakeFunder;
  clock: { now: Date };
};

export const FRONT_ORIGIN = 'http://localhost:3001';

export async function createTestApp(policy: Policy = POLICY): Promise<TestContext> {
  const store = new MemoryStore();
  const custody = new FakeCustody();
  const funder = new FakeFunder();
  const clock = { now: NOW };
  const app = await buildApp({
    store,
    custody,
    passkeys: new FakePasskeys(),
    funder,
    policy,
    network: 'testnet',
    corsOrigin: FRONT_ORIGIN,
    sessionTtlHours: 12,
    now: () => clock.now,
    log: silentLogger,
  });
  return { app, store, custody, funder, clock };
}

export function registrationResponse(credentialId: string, challenge: string): Record<string, unknown> {
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: { clientDataJSON: challenge, attestationObject: 'fake-attestation' },
  };
}

export function authenticationResponse(credentialId: string, challenge: string): Record<string, unknown> {
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: { clientDataJSON: challenge, authenticatorData: 'fake-data', signature: 'fake-signature' },
  };
}

export type Registered = { token: string; investor: { id: string; address: string; walletId: string } };

/// Runs the passkey registration and gives the session token.
export async function register(app: FastifyInstance, credentialId: string, displayName = 'Test investor'): Promise<Registered> {
  const options = await app.inject({ method: 'POST', url: '/auth/register/options', payload: { displayName } });
  const { challengeId, options: creation } = options.json<{ challengeId: string; options: { challenge: string } }>();
  const verify = await app.inject({
    method: 'POST',
    url: '/auth/register/verify',
    payload: { challengeId, response: registrationResponse(credentialId, creation.challenge) },
  });
  if (verify.statusCode !== 200) throw new Error(`register failed: ${verify.body}`);
  const session = verify.json<{ sessionToken: string; investor: Registered['investor'] }>();
  return { token: session.sessionToken, investor: session.investor };
}
