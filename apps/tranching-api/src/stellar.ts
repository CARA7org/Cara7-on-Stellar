import {
  rpc,
  Contract,
  Account,
  Address,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { environment } from './config.js';

export const server = new rpc.Server(environment.SOROBAN_RPC_URL, {
  allowHttp: environment.SOROBAN_RPC_URL.startsWith('http://'),
});

// Ephemeral source account, only used to SIMULATE read calls.
const simulationSource = Keypair.random().publicKey();

/**
 * The latest ledger, from `getHealth`. The call `getLatestLedger` of SDK
 * 16.0.1 fails on testnet since protocol 30: the SDK cannot read the new
 * ledger header.
 */
export async function latestLedger(): Promise<number> {
  return (await server.getHealth()).latestLedger;
}

/// Simulate a read-only method call and return its native value.
export async function readContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  const contract = new Contract(contractId);
  const account = new Account(simulationSource, '0');
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: environment.NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`simulate ${method} failed: ${simulation.error}`);
  }
  const returnValue = simulation.result?.retval;
  return returnValue ? scValToNative(returnValue) : null;
}

export function addressArg(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

/// Reflector `Asset::Other(Symbol)` = Vec[Symbol("Other"), Symbol(sym)].
function reflectorAssetOther(symbol: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Other'), xdr.ScVal.scvSymbol(symbol)]);
}

/// Recent price history for `symbol` through the Reflector feed (USD, 14 dp).
/// Returns `[{ ts (unix s), price (USD) }]`, oldest to newest.
export async function reflectorPrices(
  reflectorId: string,
  symbol: string,
  records: number,
): Promise<{ ts: number; price: number }[]> {
  const raw = (await readContract(reflectorId, 'prices', [
    reflectorAssetOther(symbol),
    xdr.ScVal.scvU32(records),
  ])) as { price: bigint; timestamp: bigint }[] | null;
  if (!raw || !Array.isArray(raw)) return [];
  return raw
    .map((point) => ({ ts: Number(point.timestamp), price: Number(point.price) / 1e14 }))
    .sort((a, b) => a.ts - b.ts);
}

/// Decode an RPC event topic or value (base64 XDR, or an already parsed ScVal).
export function toNative(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'string') return scValToNative(xdr.ScVal.fromXDR(value, 'base64'));
  return scValToNative(value as xdr.ScVal);
}
