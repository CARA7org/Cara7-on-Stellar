import { DfnsError, PolicyPendingError, type DfnsApiClient } from '@dfns/sdk';
import { z } from 'zod';
import { CustodyUnavailableError } from '../errors.js';
import type { StellarNetwork } from '../policy/policy.js';
import { dfnsNetworkFor } from './network.js';
import type { CustodyProvider, CustodyWallet, SignatureState } from './port.js';

const statusSchema = z.enum(['Pending', 'Executing', 'Signed', 'Confirmed', 'Failed', 'Rejected']);
const signatureSchema = z.looseObject({
  id: z.string(),
  status: statusSchema,
  approvalId: z.string().optional(),
  reason: z.string().optional(),
  signedData: z.string().optional(),
});
const approvalSchema = z.looseObject({
  id: z.string(),
  activity: z.looseObject({ signatureRequest: signatureSchema.optional() }),
});

type SignatureFields = z.infer<typeof signatureSchema>;
type WalletFields = { id: string; address?: string | undefined; signingKey: { id: string } };

/// The Dfns adapter of the server. It uses the initiator service account.
export function createDfnsCustody(client: DfnsApiClient, network: StellarNetwork): CustodyProvider {
  const dfnsNetwork = dfnsNetworkFor(network);

  const getWallet = async (walletId: string): Promise<CustodyWallet> => {
    const wallet = await callDfns('read the wallet', () => client.wallets.getWallet({ walletId }));
    return toWallet(wallet);
  };

  return {
    async createWallet({ name, tags }) {
      const wallet = await callDfns('create the wallet', () =>
        client.wallets.createWallet({ body: { network: dfnsNetwork, name, tags } }),
      );
      return wallet.address ? toWallet(wallet) : getWallet(wallet.id);
    },
    getWallet,
    async generateSignature({ keyId, transactionHex, externalId }) {
      try {
        const response = await client.keys.generateSignature({
          keyId,
          body: { kind: 'Transaction', network: dfnsNetwork, transaction: transactionHex, externalId },
        });
        return toSignatureState(response);
      } catch (error) {
        const pending = error instanceof PolicyPendingError ? signatureFromPolicyPending(error.context) : null;
        if (pending) return pending;
        throw unavailable('start the signature request', error);
      }
    },
    async getSignature({ keyId, signatureId }) {
      const response = await callDfns('read the signature request', () =>
        client.keys.getSignature({ keyId, signatureId }),
      );
      return toSignatureState(response);
    },
  };
}

/// Dfns answers HTTP 202 when a policy holds a request. The SDK throws a
/// PolicyPendingError with the body. The body is the signature request, or
/// the approval that holds it. Both give a pending signature state.
export function signatureFromPolicyPending(context: unknown): SignatureState | null {
  const approval = approvalSchema.safeParse(context);
  if (approval.success) {
    // An approval body: its own id is the approval id, not a signature id.
    const request = approval.data.activity.signatureRequest;
    if (!request) return null;
    return { ...toSignatureState(request), approvalId: request.approvalId ?? approval.data.id };
  }
  const signature = signatureSchema.extend({ keyId: z.string() }).safeParse(context);
  return signature.success ? toSignatureState(signature.data) : null;
}

export function toSignatureState(response: SignatureFields): SignatureState {
  const state: SignatureState = { signatureId: response.id, status: response.status };
  if (response.approvalId) state.approvalId = response.approvalId;
  if (response.reason) state.reason = response.reason;
  if (response.signedData) state.signedData = response.signedData;
  return state;
}

function toWallet(wallet: WalletFields): CustodyWallet {
  if (!wallet.address) {
    throw new CustodyUnavailableError('The custody provider returned a wallet without an address.');
  }
  return { walletId: wallet.id, keyId: wallet.signingKey.id, address: wallet.address };
}

async function callDfns<T>(action: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw unavailable(action, error);
  }
}

function unavailable(action: string, error: unknown): CustodyUnavailableError {
  if (error instanceof CustodyUnavailableError) return error;
  const detail =
    error instanceof DfnsError
      ? { httpStatus: error.httpStatus, message: error.message }
      : error instanceof Error
        ? { message: error.message }
        : { message: String(error) };
  return new CustodyUnavailableError(`The custody provider could not ${action}.`, detail);
}
