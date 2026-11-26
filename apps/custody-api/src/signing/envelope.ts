import { FeeBumpTransaction, Keypair, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';

export const CHANGED_TRANSACTION = 'The custody provider returned a different transaction.';
export const UNREADABLE_SIGNED = 'The custody provider returned a signed transaction that cannot be decoded.';
export const MISSING_SIGNED = 'The custody provider returned no signed transaction.';
export const BAD_SIGNATURE = 'The custody provider returned a transaction without a valid wallet signature.';

/// Decodes a hex string (with or without 0x) to base64. Bad hex gives null.
export function hexToBase64(hex: string): string | null {
  const digits = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (digits.length === 0 || digits.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(digits)) return null;
  return Buffer.from(digits, 'hex').toString('base64');
}

/// Decodes a base64 envelope. A bad envelope gives null.
export function decodeEnvelope(
  base64: string,
  networkPassphrase: string,
): Transaction | FeeBumpTransaction | null {
  try {
    return TransactionBuilder.fromXDR(base64, networkPassphrase);
  } catch {
    return null;
  }
}

export type SignedCheck = { ok: true; signedTxXdr: string } | { ok: false; reason: string };

/// The hash covers the body, not the signatures. An equal hash means that the
/// body did not change. The envelope must also carry a valid signature of the
/// wallet key on that hash.
export function checkSignedEnvelope(input: {
  signedData: string | undefined;
  preparedHash: string;
  walletAddress: string;
  networkPassphrase: string;
}): SignedCheck {
  if (!input.signedData) return { ok: false, reason: MISSING_SIGNED };
  const base64 = hexToBase64(input.signedData);
  const signed = base64 === null ? null : decodeEnvelope(base64, input.networkPassphrase);
  if (base64 === null || signed === null) return { ok: false, reason: UNREADABLE_SIGNED };
  if (signed instanceof FeeBumpTransaction) return { ok: false, reason: CHANGED_TRANSACTION };
  const hash = signed.hash();
  if (hash.toString('hex') !== input.preparedHash) return { ok: false, reason: CHANGED_TRANSACTION };
  const wallet = Keypair.fromPublicKey(input.walletAddress);
  const signedByWallet = signed.signatures.some(
    (signature) =>
      signature.hint().equals(wallet.signatureHint()) && wallet.verify(hash, signature.signature()),
  );
  if (!signedByWallet) return { ok: false, reason: BAD_SIGNATURE };
  return { ok: true, signedTxXdr: base64 };
}
