import {
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';
import { DIFFERENT_TRANSACTION, OperatorError, errorMessage } from './errors.js';
import { OperationRegistry, type Operation, type OperationStatus } from './operations.js';
import {
  TIME_BOUND_SECONDS,
  type ChainOutcome,
  type OperatorCustody,
  type OperatorRole,
  type RoleWallet,
  type SignatureState,
  type StellarNetwork,
} from './ports.js';

/**
 * The operator signing flow.
 *
 * 1. Build the transaction with the role wallet as source, then prepare it.
 * 2. Ask the custody port for a signature.
 * 3. Signed at once: check the hash, submit, run the follow-up.
 *    Pending: keep the operation. `refresh` polls the custody port later.
 *
 * No step reads a Stellar secret.
 */
export interface ContractCall {
  type: 'contract';
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}

export interface ClassicCall {
  type: 'classic';
  method: string;
  operation: xdr.Operation;
}

/** A Soroban operation that is not a plain contract call, for example a contract deploy. */
export interface HostFunctionCall {
  type: 'host-function';
  method: string;
  operation: xdr.Operation;
}

export interface OperatorRequest {
  kind: string;
  role: OperatorRole;
  call: ContractCall | ClassicCall | HostFunctionCall;
  /** Runs after the transaction is on chain. Its value becomes the operation result. */
  finish?: (outcome: ChainOutcome) => Promise<unknown>;
}

export interface OperatorOptions {
  custody: OperatorCustody;
  network: StellarNetwork;
  networkPassphrase: string;
  registry?: OperationRegistry;
  /** Clock in milliseconds. Tests set it. */
  now?: () => number;
}

interface Work {
  request: OperatorRequest;
  wallet: RoleWallet;
  prepared: Transaction;
}

const REJECTED_PREFIX = 'The custody provider rejected the signature: ';
const FAILED_PREFIX = 'The custody provider could not sign the transaction: ';

export const EXPIRED =
  'The time bound of the transaction passed before the approval. Start the operation again.';

/** Contract calls return i128 values as BigInt. JSON needs strings. */
export function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
  );
}

/** At most 47 characters, below the Dfns limit of 50. */
function externalIdFor(role: OperatorRole, prepared: Transaction): string {
  return `cara7-${role}-${prepared.hash().toString('hex').slice(0, 32)}`;
}

export class Operator {
  readonly registry: OperationRegistry;
  private readonly work = new Map<string, Work>();
  private readonly refreshing = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: OperatorOptions) {
    this.registry = options.registry ?? new OperationRegistry();
    this.now = options.now ?? Date.now;
  }

  resolve(role: OperatorRole): Promise<RoleWallet> {
    return this.options.custody.resolveRole(role);
  }

  /** Starts an operation. The result is `done`, `awaiting_approval`, `rejected` or `failed`. */
  async run(request: OperatorRequest): Promise<Operation> {
    const { call } = request;
    const operation = this.registry.start({
      kind: request.kind,
      role: request.role,
      contractId: call.type === 'contract' ? call.contractId : null,
      method: call.method,
    });
    let state: SignatureState;
    try {
      const wallet = await this.options.custody.resolveRole(request.role);
      const prepared = await this.prepare(request, wallet);
      this.work.set(operation.id, { request, wallet, prepared });
      state = await this.options.custody.requestSignature({
        role: request.role,
        transaction: prepared,
        externalId: externalIdFor(request.role, prepared),
      });
    } catch (error) {
      // The custody provider gave no signature request: forget the operation.
      this.work.delete(operation.id);
      this.registry.discard(operation.id);
      throw error;
    }
    return this.advance(operation.id, state);
  }

  /** Polls the custody provider once for a pending operation, then submits when signed. */
  async refresh(id: string): Promise<Operation> {
    const operation = this.registry.get(id);
    if (!operation) throw new OperatorError(`No operation has the id ${id}.`, 404);
    const work = this.work.get(id);
    const waiting = operation.status === 'awaiting_approval' && operation.signatureId;
    if (!waiting || !work || this.refreshing.has(id)) return operation;
    if (this.expired(work.prepared)) return this.close(id, 'failed', EXPIRED);
    this.refreshing.add(id);
    try {
      const signatureId = operation.signatureId ?? '';
      const state = await this.options.custody.refreshSignature(operation.role, signatureId);
      return await this.advance(id, state);
    } finally {
      this.refreshing.delete(id);
    }
  }

  private async prepare(request: OperatorRequest, wallet: RoleWallet): Promise<Transaction> {
    const account = await this.options.network.sourceAccount(wallet.address);
    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.options.networkPassphrase,
    }).setTimeout(TIME_BOUND_SECONDS[request.role]);
    const { call } = request;
    if (call.type === 'classic') return builder.addOperation(call.operation).build();
    const operation =
      call.type === 'contract'
        ? new Contract(call.contractId).call(call.method, ...call.args)
        : call.operation;
    return this.options.network.prepare(builder.addOperation(operation).build());
  }

  private async advance(id: string, state: SignatureState): Promise<Operation> {
    const ids = { signatureId: state.signatureId, approvalId: state.approvalId ?? null };
    const reason = state.reason ?? 'no reason given';
    switch (state.status) {
      case 'pending':
        return this.registry.update(id, { status: 'awaiting_approval', ...ids });
      case 'rejected':
        return this.close(id, 'rejected', `${REJECTED_PREFIX}${reason}`, ids);
      case 'failed':
        return this.close(id, 'failed', `${FAILED_PREFIX}${reason}`, ids);
      case 'signed':
        this.registry.update(id, { status: 'submitting', ...ids });
        return this.submit(id, state.signedXdr);
    }
  }

  private async submit(id: string, signedXdr: string | undefined): Promise<Operation> {
    const work = this.work.get(id);
    if (!work) return this.close(id, 'failed', 'The backend lost the prepared transaction.');
    if (this.expired(work.prepared)) return this.close(id, 'failed', EXPIRED);
    let outcome: ChainOutcome;
    try {
      const signed = this.verify(work, signedXdr);
      outcome =
        work.request.call.type === 'classic'
          ? await this.options.network.submitClassic(signed)
          : await this.options.network.submitContractCall(signed);
    } catch (error) {
      return this.close(id, 'failed', errorMessage(error));
    }
    this.registry.update(id, { hash: outcome.hash });
    try {
      const value = work.request.finish ? await work.request.finish(outcome) : outcome.result;
      this.work.delete(id);
      return this.registry.update(id, { status: 'done', result: jsonSafe(value) });
    } catch (error) {
      const reason = errorMessage(error);
      const message = `The transaction ${outcome.hash} is on chain. The follow-up failed: `;
      return this.close(id, 'failed', message + reason);
    }
  }

  /** Refuses a signed envelope whose body differs from the prepared one. */
  private verify(work: Work, signedXdr: string | undefined): Transaction {
    if (!signedXdr) {
      throw new OperatorError('The custody provider returned no signed transaction.', 502);
    }
    let signed: Transaction | FeeBumpTransaction;
    try {
      signed = TransactionBuilder.fromXDR(signedXdr, this.options.networkPassphrase);
    } catch {
      throw new OperatorError(DIFFERENT_TRANSACTION, 502);
    }
    // The hash covers the body, not the signatures: an equal hash means an unchanged body.
    if (signed instanceof FeeBumpTransaction || !signed.hash().equals(work.prepared.hash())) {
      throw new OperatorError(DIFFERENT_TRANSACTION, 502);
    }
    const signer = Keypair.fromPublicKey(work.wallet.address);
    const hash = signed.hash();
    if (!signed.signatures.some((signature) => signer.verify(hash, signature.signature()))) {
      const role = work.request.role;
      throw new OperatorError(
        `The custody provider returned no valid signature of the ${role} wallet.`,
        502,
      );
    }
    return signed;
  }

  private expired(prepared: Transaction): boolean {
    const maxTime = Number(prepared.timeBounds?.maxTime ?? 0);
    return maxTime > 0 && this.now() / 1000 > maxTime;
  }

  private close(
    id: string,
    status: Extract<OperationStatus, 'rejected' | 'failed'>,
    error: string,
    extra: Partial<Operation> = {},
  ): Operation {
    this.work.delete(id);
    return this.registry.update(id, { ...extra, status, error });
  }
}
