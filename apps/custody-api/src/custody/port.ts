// The custody provider port. The server uses the Dfns adapter. The tests use
// a fake that signs with a key that the test creates.

export type CustodyWallet = {
  walletId: string;
  keyId: string;
  address: string;
};

export type DfnsSignatureStatus = 'Pending' | 'Executing' | 'Signed' | 'Confirmed' | 'Failed' | 'Rejected';

export type SignatureState = {
  signatureId: string;
  status: DfnsSignatureStatus;
  approvalId?: string;
  reason?: string;
  /// The signed envelope in hex, maybe with a 0x prefix.
  signedData?: string;
};

export interface CustodyProvider {
  createWallet(input: { name: string; tags: string[] }): Promise<CustodyWallet>;
  getWallet(walletId: string): Promise<CustodyWallet>;
  /// Starts a signature request for a prepared transaction (hex envelope with 0x).
  generateSignature(input: {
    keyId: string;
    transactionHex: string;
    externalId: string;
  }): Promise<SignatureState>;
  getSignature(input: { keyId: string; signatureId: string }): Promise<SignatureState>;
}

/// The tag of every investor wallet. The Dfns approval policy and the
/// checker select the investor wallets with it.
export const INVESTOR_TAG = 'cara7:investor';
