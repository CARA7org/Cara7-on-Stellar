import { setTimeout as delay } from 'node:timers/promises';
import {
  rpc,
  Horizon,
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { environment } from '../config.js';
import { errorMessage } from '../custody/errors.js';
import type { ChainOutcome, StellarNetwork } from '../custody/ports.js';

/**
 * The network port of operator custody: Soroban RPC for contract calls and
 * Horizon for classic operations. This module holds no key. The custody
 * port (custody/dfns.ts) gives the signatures.
 */
export const server = new rpc.Server(environment.SOROBAN_RPC_URL);
const horizon = new Horizon.Server(environment.HORIZON_URL);

const POLL_ATTEMPTS = 45;

/// Read-only contract call via simulation - no signature, no fee, no state.
export async function readContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  // A simulation needs a source account, but no signature and no funds.
  const source = new Account(Keypair.random().publicKey(), '0');
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: environment.NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(`Simulation failed (${method})`);
  }
  const value = simulation.result?.retval;
  return value ? scValToNative(value) : null;
}

export function addressArg(value: string): xdr.ScVal {
  return new Address(value).toScVal();
}

export function i128Arg(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: 'i128' });
}

export function u32Arg(value: number): xdr.ScVal {
  return xdr.ScVal.scvU32(value);
}

/** The contract method of a one-operation Soroban transaction, for error messages. */
export function methodOf(transaction: Transaction): string {
  const operation = transaction.operations[0];
  if (operation?.type !== 'invokeHostFunction') return operation?.type ?? 'transaction';
  const hostFunction = operation.func;
  if (hostFunction.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    return 'invokeHostFunction';
  }
  return hostFunction.invokeContract().functionName().toString();
}

async function sourceAccount(address: string): Promise<Account> {
  try {
    return await server.getAccount(address);
  } catch (error) {
    const hint =
      environment.NETWORK_PASSPHRASE === Networks.TESTNET
        ? ` Fund it: https://friendbot.stellar.org/?addr=${address}`
        : '';
    throw new Error(`The account ${address} is not readable (${errorMessage(error)}).${hint}`);
  }
}

/**
 * A margin on the write bytes of each Soroban transaction.
 *
 * A contract parks a payout when its transfer fails: `push_batch` for a
 * holder with no trustline, `distribute` for a frozen fee recipient. The
 * failed sub-call rolls back, but its entries stay in the read-write
 * footprint. The network counts the bytes of these entries. The simulation
 * does not count them.
 *
 * On testnet on 2026-11-23, a `push_batch` with one failed transfer needed
 * 968 write bytes, and its simulation declared 744. The difference is the
 * 224 bytes of the balance entry of the paying agent. The network refused
 * the transaction with `ResourceLimitExceeded`, and no payout was parked.
 *
 * 2,048 bytes cover the worst batch: one balance entry (224 bytes) and one
 * trustline (116 bytes) for each of the 10 holders. At the testnet rate of
 * 2026-11-23, the margin costs less than 1,000 stroops for each transaction.
 * The network refunds the part of the fee margin that a transaction does
 * not use.
 */
export const WRITE_MARGIN_BYTES = 2048;
export const RESOURCE_FEE_MARGIN_STROOPS = 10_000n;

/** Adds the margin to the simulated resources of a transaction. */
export function withResourceMargin(simulation: rpc.Api.SimulateTransactionSuccessResponse): void {
  const data = simulation.transactionData.build();
  const resources = data.resources();
  simulation.transactionData
    .setResources(resources.instructions(), resources.diskReadBytes(), resources.writeBytes() + WRITE_MARGIN_BYTES)
    .setResourceFee((data.resourceFee().toBigInt() + RESOURCE_FEE_MARGIN_STROOPS).toString());
}

async function prepare(transaction: Transaction): Promise<Transaction> {
  try {
    const simulation = await server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error);
    withResourceMargin(simulation);
    return rpc.assembleTransaction(transaction, simulation).build();
  } catch (error) {
    throw new Error(`Simulation failed (${methodOf(transaction)}): ${errorMessage(error)}`);
  }
}

async function submitContractCall(signed: Transaction): Promise<ChainOutcome> {
  const method = methodOf(signed);
  const sent = await server.sendTransaction(signed);
  if (sent.status === 'ERROR') {
    const code = sent.errorResult?.result().switch().name ?? 'no result code';
    throw new Error(`Transaction rejected (${method}): ${code}`);
  }
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await delay(1000);
    const result = await server.getTransaction(sent.hash);
    if (result.status === 'SUCCESS') {
      const value = result.returnValue;
      return { hash: sent.hash, result: value ? scValToNative(value) : null };
    }
    if (result.status === 'FAILED') throw new Error(`On-chain failure (${method})`);
  }
  throw new Error(`No confirmation (${method})`);
}

const horizonErrorSchema = z.object({
  response: z.object({
    data: z.object({
      extras: z.object({
        result_codes: z.object({
          transaction: z.string().optional(),
          operations: z.array(z.string()).optional(),
        }),
      }),
    }),
  }),
});

function horizonReason(error: unknown): string {
  const parsed = horizonErrorSchema.safeParse(error);
  if (!parsed.success) return errorMessage(error);
  const codes = parsed.data.response.data.extras.result_codes;
  return [codes.transaction, ...(codes.operations ?? [])].filter(Boolean).join(', ');
}

async function submitClassic(signed: Transaction): Promise<ChainOutcome> {
  try {
    const response = await horizon.submitTransaction(signed);
    return { hash: response.hash, result: null };
  } catch (error) {
    throw new Error(`Horizon refused the transaction: ${horizonReason(error)}`);
  }
}

export const rpcNetwork: StellarNetwork = {
  sourceAccount,
  prepare,
  read: readContract,
  submitContractCall,
  submitClassic,
};
