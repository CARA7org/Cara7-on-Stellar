import { DfnsApiClient, DfnsError, PolicyPendingError } from '@dfns/sdk';
import { AsymmetricKeySigner } from '@dfns/sdk-keysigner';
import { Networks } from '@stellar/stellar-sdk';
import { z } from 'zod';
import type { Environment } from '../config.js';
import { OperatorError, errorMessage, missingSetting } from './errors.js';
import type {
  OperatorCustody,
  OperatorRole,
  RoleWallet,
  SignatureInput,
  SignatureState,
} from './ports.js';

/**
 * Operator custody through Dfns. One org-managed Dfns wallet for each role.
 * The backend service account starts each signature request. The Dfns
 * policy of the admin, servicer and reporter wallets asks a person to
 * approve, so their requests come back `Pending`. Dfns signs only: the
 * backend submits the transaction itself.
 */
type OptionalDfnsSetting =
  | 'DFNS_ORG_ID'
  | 'DFNS_AUTH_TOKEN'
  | 'DFNS_CRED_ID'
  | 'DFNS_PRIVATE_KEY'
  | 'DFNS_ADMIN_WALLET_ID'
  | 'DFNS_SERVICER_WALLET_ID'
  | 'DFNS_REPORTER_WALLET_ID'
  | 'DFNS_CRANK_WALLET_ID';

export type DfnsSettings = Pick<Environment, 'DFNS_API_URL'> &
  Partial<Pick<Environment, OptionalDfnsSetting>>;

export const WALLET_SETTING = {
  admin: 'DFNS_ADMIN_WALLET_ID',
  servicer: 'DFNS_SERVICER_WALLET_ID',
  reporter: 'DFNS_REPORTER_WALLET_ID',
  crank: 'DFNS_CRANK_WALLET_ID',
} as const satisfies Record<OperatorRole, keyof DfnsSettings>;

const EXTERNAL_ID_LIMIT = 50;

type DfnsSignature = Pick<
  Awaited<ReturnType<DfnsApiClient['keys']['getSignature']>>,
  'id' | 'status' | 'reason' | 'signedData' | 'approvalId'
>;

interface TransactionBody {
  kind: 'Transaction';
  network: DfnsStellarNetwork;
  transaction: string;
  externalId?: string;
}

/** The part of the Dfns client that this backend uses. `DfnsApiClient` matches it. */
export interface DfnsApi {
  wallets: {
    getWallet(request: { walletId: string }): Promise<{
      network: string;
      address?: string | undefined;
      signingKey: { id: string };
    }>;
  };
  keys: {
    generateSignature(request: { keyId: string; body: TransactionBody }): Promise<DfnsSignature>;
    getSignature(request: { keyId: string; signatureId: string }): Promise<DfnsSignature>;
  };
}

export type DfnsStellarNetwork = 'StellarTestnet' | 'Stellar';

export function dfnsNetwork(networkPassphrase: string): DfnsStellarNetwork {
  if (networkPassphrase === Networks.TESTNET) return 'StellarTestnet';
  if (networkPassphrase === Networks.PUBLIC) return 'Stellar';
  throw new OperatorError(
    'Dfns signs only for the Stellar public network and the Stellar test network.',
    503,
  );
}

function required(value: string | undefined, name: string): string {
  if (!value) throw missingSetting(name, 'sign with Dfns');
  return value;
}

function buildClient(settings: DfnsSettings): DfnsApi {
  const authToken = required(settings.DFNS_AUTH_TOKEN, 'DFNS_AUTH_TOKEN');
  const credId = required(settings.DFNS_CRED_ID, 'DFNS_CRED_ID');
  const privateKey = required(settings.DFNS_PRIVATE_KEY, 'DFNS_PRIVATE_KEY');
  return new DfnsApiClient({
    baseUrl: settings.DFNS_API_URL,
    orgId: settings.DFNS_ORG_ID || undefined,
    authToken,
    signer: new AsymmetricKeySigner({ credId, privateKey }),
  });
}

function hexToBase64(hex: string): string | null {
  const digits = hex.replace(/^0x/, '');
  if (digits.length === 0 || digits.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(digits)) return null;
  return Buffer.from(digits, 'hex').toString('base64');
}

/** Maps a Dfns signature request to the port state. */
export function toSignatureState(response: DfnsSignature): SignatureState {
  const base = { signatureId: response.id, approvalId: response.approvalId };
  switch (response.status) {
    case 'Pending':
    case 'Executing':
      return { ...base, status: 'pending' };
    case 'Signed':
    case 'Confirmed': {
      const signedXdr = response.signedData ? hexToBase64(response.signedData) : null;
      if (!signedXdr) {
        return { ...base, status: 'failed', reason: 'Dfns returned no signed transaction.' };
      }
      return { ...base, status: 'signed', signedXdr };
    }
    case 'Rejected':
      return { ...base, status: 'rejected', reason: response.reason ?? 'Dfns gave no reason.' };
    case 'Failed':
      return { ...base, status: 'failed', reason: response.reason ?? 'Dfns gave no reason.' };
  }
}

const pendingSignatureSchema = z.object({
  id: z.string(),
  keyId: z.string(),
  status: z.enum(['Pending', 'Executing', 'Signed', 'Confirmed', 'Failed', 'Rejected']),
  reason: z.string().optional(),
  signedData: z.string().optional(),
  approvalId: z.string().optional(),
});

/** The SDK throws `PolicyPendingError` on HTTP 202. Its context is the response body. */
export function fromPolicyPending(context: unknown): SignatureState {
  const parsed = pendingSignatureSchema.safeParse(context);
  if (!parsed.success) {
    throw new OperatorError(
      'Dfns asks for an approval, but it returned no signature request.',
      502,
    );
  }
  return toSignatureState(parsed.data);
}

function readable(error: unknown, action: string): OperatorError {
  if (error instanceof OperatorError) return error;
  if (error instanceof DfnsError) {
    const message = `Dfns refused to ${action} (HTTP ${error.httpStatus}): ${error.message}`;
    return new OperatorError(message, 502);
  }
  return new OperatorError(`Dfns is not reachable to ${action}: ${errorMessage(error)}`, 502);
}

export class DfnsCustody implements OperatorCustody {
  private api: DfnsApi | null;
  private readonly wallets = new Map<OperatorRole, RoleWallet>();

  constructor(
    private readonly settings: DfnsSettings,
    private readonly networkPassphrase: string,
    api?: DfnsApi,
  ) {
    this.api = api ?? null;
  }

  /** Reads the wallet of the role once, then keeps it in memory. */
  async resolveRole(role: OperatorRole): Promise<RoleWallet> {
    const cached = this.wallets.get(role);
    if (cached) return cached;
    const setting = WALLET_SETTING[role];
    const walletId = this.settings[setting];
    if (!walletId) throw missingSetting(setting, `sign as the ${role} role`);
    const network = dfnsNetwork(this.networkPassphrase);
    let wallet: Awaited<ReturnType<DfnsApi['wallets']['getWallet']>>;
    try {
      wallet = await this.client().wallets.getWallet({ walletId });
    } catch (error) {
      throw readable(error, `read the ${role} wallet ${walletId}`);
    }
    if (wallet.network !== network) {
      throw new OperatorError(
        `The ${role} wallet ${walletId} is on ${wallet.network}, but this backend uses ${network}.`,
        503,
      );
    }
    if (!wallet.address) {
      throw new OperatorError(`The ${role} wallet ${walletId} has no address.`, 503);
    }
    const resolved = { walletId, keyId: wallet.signingKey.id, address: wallet.address };
    this.wallets.set(role, resolved);
    return resolved;
  }

  async requestSignature(input: SignatureInput): Promise<SignatureState> {
    const wallet = await this.resolveRole(input.role);
    const externalId = input.externalId;
    const body: TransactionBody = {
      kind: 'Transaction',
      network: dfnsNetwork(this.networkPassphrase),
      // Dfns takes the envelope as hex with a 0x prefix, never base64.
      transaction: `0x${input.transaction.toEnvelope().toXDR('hex')}`,
      ...(externalId && externalId.length <= EXTERNAL_ID_LIMIT ? { externalId } : {}),
    };
    try {
      const response = await this.client().keys.generateSignature({ keyId: wallet.keyId, body });
      return toSignatureState(response);
    } catch (error) {
      if (error instanceof PolicyPendingError) return fromPolicyPending(error.context);
      throw readable(error, `sign as the ${input.role} role`);
    }
  }

  async refreshSignature(role: OperatorRole, signatureId: string): Promise<SignatureState> {
    const wallet = await this.resolveRole(role);
    try {
      const response = await this.client().keys.getSignature({ keyId: wallet.keyId, signatureId });
      return toSignatureState(response);
    } catch (error) {
      if (error instanceof PolicyPendingError) return fromPolicyPending(error.context);
      throw readable(error, `read the signature request ${signatureId}`);
    }
  }

  private client(): DfnsApi {
    this.api ??= buildClient(this.settings);
    return this.api;
  }
}
