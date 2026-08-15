import {
  rpc,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { environment } from '../config.js';

export const server = new rpc.Server(environment.SOROBAN_RPC_URL);

/// Invokes a contract method signed by the servicer, waits for confirmation.
export async function invokeSigned(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const secret = environment.SERVICER_SECRET;
  if (!secret) throw new Error('SERVICER_SECRET missing: on-chain operation impossible');
  const keypair = Keypair.fromSecret(secret);
  const account = await server.getAccount(keypair.publicKey());
  const contract = new Contract(contractId);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: environment.NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(120)
    .build();

  const prepared = await server.prepareTransaction(transaction);
  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`Transaction rejected (${method})`);
  for (let attempt = 0; attempt < 45; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await server.getTransaction(sent.hash);
    if (result.status === 'SUCCESS') {
      const value = result.returnValue;
      return { hash: sent.hash, result: value ? scValToNative(value) : null };
    }
    if (result.status === 'FAILED') throw new Error(`On-chain failure (${method})`);
  }
  throw new Error(`No confirmation (${method})`);
}

/// Read-only contract call via simulation - no signature, no fee, no state.
export async function readContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  const account = await server.getAccount(
    // Any funded account works as the simulation source; the servicer's is
    // always available in this backend.
    servicerPublicKey(),
  );
  const contract = new Contract(contractId);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: environment.NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
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

export function servicerPublicKey(): string {
  const secret = environment.SERVICER_SECRET;
  if (!secret) throw new Error('SERVICER_SECRET missing');
  return Keypair.fromSecret(secret).publicKey();
}
