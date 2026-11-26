import { produce } from "immer";
import { create } from "zustand";
import type { ProviderId } from "@/services/signers/types";

/** A notice for the connect button to show in the user's language. */
export type WalletNotice = "contract-address" | null;

export interface StellarWalletState {
  set: (x: (s: StellarWalletState) => void) => void;
  get: () => StellarWalletState;
  address: string | null;
  connected: boolean;
  /** The provider that signs for the connected address. */
  provider: ProviderId | null;
  /** The display name of the Dfns investor. Null for the Wallets Kit. */
  investorName: string | null;
  notice: WalletNotice;
  /** The connect menu in the header is open. */
  connectMenuOpen: boolean;
}

const useStellarWalletStore = create<StellarWalletState>((set, get) => {
  const setProducerFn = (fn: (s: StellarWalletState) => void) =>
    set(produce(fn));
  return {
    set: setProducerFn,
    get: () => get(),
    address: null,
    connected: false,
    provider: null,
    investorName: null,
    notice: null,
    connectMenuOpen: false,
  };
});

export default useStellarWalletStore;

/** A C-address is a contract account. It cannot be a transaction source (design section 8.3). */
export function isContractAddress(address: string): boolean {
  return address.startsWith("C");
}

/** Removes the connected wallet from the state (inside a `set` producer). */
export function clearWallet(s: StellarWalletState): void {
  s.address = null;
  s.connected = false;
  s.provider = null;
  s.investorName = null;
}

/** Sets a Dfns policy wallet as the connected wallet. */
export function connectDfnsWallet(investor: { address: string; displayName: string }): void {
  useStellarWalletStore.getState().set((s) => {
    if (isContractAddress(investor.address)) {
      s.notice = "contract-address";
      return;
    }
    s.address = investor.address;
    s.connected = true;
    s.provider = "dfns";
    s.investorName = investor.displayName;
    s.connectMenuOpen = false;
  });
}

/** Opens the connect menu in the header (for a "Connect Wallet" button in a page). */
export function openConnectMenu(): void {
  useStellarWalletStore.getState().set((s) => {
    s.connectMenuOpen = true;
  });
}
