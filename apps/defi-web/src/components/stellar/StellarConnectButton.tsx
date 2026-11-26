"use client";

import { useEffect } from "react";
import { twMerge } from "tailwind-merge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { LogOut } from "lucide-react";
import toast from "react-hot-toast";
import useStellarWalletStore, { clearWallet } from "@/stores/useStellarWalletStore";
import { useLocale } from "@/lib/i18n";
import { logout } from "@/services/custody";
import ConnectChoices from "./ConnectChoices";
import DfnsWalletMenu from "./DfnsWalletMenu";

function abbreviateStellarAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * SSR-safe: the kit is only loaded via dynamic import() inside event handlers,
 * so this component never triggers module evaluation on the server.
 * With no wallet connected, the menu offers the self-custody wallet (the
 * kit modal) or a Dfns policy wallet (passkey).
 */
export default function StellarConnectButton({
  className,
}: {
  className?: string;
}) {
  const address = useStellarWalletStore((s) => s.address);
  const connected = useStellarWalletStore((s) => s.connected);
  const provider = useStellarWalletStore((s) => s.provider);
  const notice = useStellarWalletStore((s) => s.notice);
  const menuOpen = useStellarWalletStore((s) => s.connectMenuOpen);
  const setStore = useStellarWalletStore((s) => s.set);
  const { dictionary } = useLocale();

  // A notice comes from the kit events, outside the locale provider.
  useEffect(() => {
    if (notice !== "contract-address") return;
    toast.error(dictionary.contractAddressRejected);
    setStore((s) => {
      s.notice = null;
    });
  }, [notice, dictionary, setStore]);

  const setMenuOpen = (open: boolean) =>
    setStore((s) => {
      s.connectMenuOpen = open;
    });

  const handleConnect = async () => {
    if (connected) return;
    setMenuOpen(false);
    try {
      const { StellarWalletsKit } = await import(
        "@creit-tech/stellar-wallets-kit"
      );
      await StellarWalletsKit.authModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // user closing the modal is not an error worth toasting
      if (!/closed|cancel/i.test(message)) {
        toast.error(dictionary.walletConnectionFailed(message));
      }
    }
  };

  const handleDisconnect = async () => {
    const { StellarWalletsKit } = await import(
      "@creit-tech/stellar-wallets-kit"
    );
    await StellarWalletsKit.disconnect();
  };

  const handleDfnsLogout = async () => {
    await logout();
    setStore((s) => {
      clearWallet(s);
      s.connectMenuOpen = false;
    });
  };

  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger asChild>
        <Button
          className={twMerge(
            "flex items-center gap-2 text-white rounded-full bg-[linear-gradient(90deg,#04003c_0%,#570a61_55%,#91117e_100%)]",
            className
          )}
        >
          {!connected && <span>{dictionary.connect}</span>}
          {connected && address && (
            <span>{abbreviateStellarAddress(address)}</span>
          )}
          {connected && provider === "dfns" && (
            <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              Dfns
            </span>
          )}
        </Button>
      </PopoverTrigger>
      {!connected && (
        <PopoverContent className="mr-2 w-80">
          <ConnectChoices onSelfCustody={handleConnect} />
        </PopoverContent>
      )}
      {connected && address && provider === "dfns" && (
        <PopoverContent className="mr-2 w-72">
          <DfnsWalletMenu
            address={address}
            shortAddress={abbreviateStellarAddress(address)}
            onLogout={handleDfnsLogout}
          />
        </PopoverContent>
      )}
      {connected && address && provider !== "dfns" && (
        <PopoverContent className="mr-2 w-40">
          <div className="flex flex-row gap-2 justify-between items-center">
            <div className="flex-1">
              {abbreviateStellarAddress(address)}
            </div>
            <button
              onClick={handleDisconnect}
              className="p-1 rounded transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
