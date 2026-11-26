"use client";

import { useEffect, useRef } from "react";
import useStellarWalletStore, {
  clearWallet,
  connectDfnsWallet,
  isContractAddress,
} from "@/stores/useStellarWalletStore";
import { hasSession, me, onSessionEnded } from "@/services/custody";

/**
 * Client-only component that initialises the Stellar Wallets Kit.
 * All kit imports are dynamic to guarantee zero server-side evaluation.
 * MUST be imported exclusively via next/dynamic with { ssr: false }.
 *
 * It also restores a Dfns session when a session token exists. While a
 * Dfns wallet is connected, the kit events do not change the wallet state.
 */
export default function StellarClientOnly({
  children,
}: {
  children: React.ReactNode;
}) {
  const initialized = useRef(false);
  const setStore = useStellarWalletStore((s) => s.set);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // Dfns: restore the session. A refused token is removed by the custody client.
    if (hasSession()) {
      me()
        .then(connectDfnsWallet)
        .catch(() => undefined);
    }
    onSessionEnded(() =>
      setStore((s) => {
        if (s.provider === "dfns") clearWallet(s);
      })
    );

    (async () => {
      const [{ StellarWalletsKit, KitEventType }, { defaultModules }] =
        await Promise.all([
          import("@creit-tech/stellar-wallets-kit"),
          import("@creit-tech/stellar-wallets-kit/modules/utils"),
        ]);

      StellarWalletsKit.init({
        modules: defaultModules(),
      });

      StellarWalletsKit.on(KitEventType.STATE_UPDATED, (event) => {
        const addr = event.payload.address ?? null;
        // Smart-contract accounts are a non-goal (design section 8.3).
        if (addr && isContractAddress(addr)) {
          setStore((s) => {
            if (s.provider === "dfns") return;
            clearWallet(s);
            s.notice = "contract-address";
          });
          StellarWalletsKit.disconnect().catch(() => undefined);
          return;
        }
        setStore((s) => {
          if (s.provider === "dfns") return;
          s.address = addr;
          s.connected = !!addr;
          s.provider = addr ? "wallets-kit" : null;
        });
      });

      StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
        setStore((s) => {
          if (s.provider === "dfns") return;
          clearWallet(s);
        });
      });
    })();
  }, [setStore]);

  return <>{children}</>;
}
