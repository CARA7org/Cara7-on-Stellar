/**
 * The signer registry. It replaces the kit-coupled lines in submitInvoke.
 * The pipeline asks for the signer of the connected provider. It does not
 * change above the signature (build, simulate, prepare) or below it (send,
 * poll), and the call sites do not change.
 */
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { dfnsSigner } from "./dfns";
import type { ProviderId, WalletSigner } from "./types";
import { walletsKitSigner } from "./walletsKit";

const SIGNERS: Record<ProviderId, WalletSigner> = {
  "wallets-kit": walletsKitSigner,
  dfns: dfnsSigner,
};

export function signerFor(provider: ProviderId): WalletSigner {
  return SIGNERS[provider];
}

/** The signer of the connected wallet. With no provider, the Wallets Kit signs, as before. */
export function connectedSigner(): WalletSigner {
  return signerFor(useStellarWalletStore.getState().provider ?? "wallets-kit");
}

export {
  signAndSubmit,
  waitAndSubmit,
  type PendingContext,
  type SignedTransaction,
  type SubmitSigned,
} from "./approval";
export { pendingApprovalFor } from "./dfns";
export * from "./types";
