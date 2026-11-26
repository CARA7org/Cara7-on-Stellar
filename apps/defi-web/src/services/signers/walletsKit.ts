import type { WalletSigner } from "./types";

/**
 * The self-custody signer. It asks the Stellar Wallets Kit for one envelope
 * signature. The signature call is the same as before the signer registry.
 * The kit loads only through dynamic import(), so the server never evaluates it.
 */
export const walletsKitSigner: WalletSigner = {
  id: "wallets-kit",
  txTimeoutSeconds: 120,

  async getAddress() {
    const { StellarWalletsKit } = await import("@creit-tech/stellar-wallets-kit");
    const { address } = await StellarWalletsKit.getAddress();
    return address;
  },

  async signTransaction(xdr, { networkPassphrase, address }) {
    const { StellarWalletsKit } = await import("@creit-tech/stellar-wallets-kit");
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
      networkPassphrase,
      address,
    });
    return { signedTxXdr };
  },
};
