"use client";

import { useState } from "react";
import { KeyRound, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocale } from "@/lib/i18n";
import { CustodyError, loginWithPasskey, registerWithPasskey } from "@/services/custody";
import { connectDfnsWallet } from "@/stores/useStellarWalletStore";

const BOX_CLASS = "rounded-lg border border-gray-200 dark:border-neutral-800 p-3";

const SMALL_GRADIENT =
  "w-full rounded-full text-white bg-[linear-gradient(90deg,#04003c_0%,#570a61_55%,#91117e_100%)] disabled:opacity-50";

function ChoiceTitle({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <span className="flex items-start gap-3">
      {icon}
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-gray-500">{hint}</span>
      </span>
    </span>
  );
}

/** The Dfns policy wallet: sign in with a passkey, or create an account with a display name. */
function DfnsChoice() {
  const { dictionary } = useLocale();
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState<"login" | "register" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameLength = displayName.trim().length;

  const connectDfns = async (action: "login" | "register") => {
    setBusy(action);
    setError(null);
    try {
      const investor =
        action === "login" ? await loginWithPasskey() : await registerWithPasskey(displayName);
      connectDfnsWallet(investor);
    } catch (e) {
      if (e instanceof CustodyError && e.code === "passkey_cancelled") {
        setError(dictionary.passkeyCancelled);
      } else {
        setError(e instanceof Error ? e.message : dictionary.dfnsConnectFailed);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`flex flex-col gap-2 ${BOX_CLASS}`}>
      <ChoiceTitle
        icon={<KeyRound className="mt-0.5 h-4 w-4 shrink-0" />}
        title={dictionary.connectDfns}
        hint={dictionary.connectDfnsHint}
      />
      <Button onClick={() => connectDfns("login")} className={SMALL_GRADIENT} disabled={busy !== null}>
        {busy === "login" ? dictionary.dfnsWaitingPasskey : dictionary.dfnsSignIn}
      </Button>
      <p className="mt-1 text-xs text-gray-500">{dictionary.dfnsCreatePrompt}</p>
      <div className="flex items-center gap-2">
        <Input
          value={displayName}
          maxLength={64}
          placeholder={dictionary.dfnsDisplayName}
          aria-label={dictionary.dfnsDisplayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="h-9"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => connectDfns("register")}
          disabled={busy !== null || nameLength < 1 || nameLength > 64}
          className="shrink-0 rounded-full"
        >
          {busy === "register" ? dictionary.dfnsWaitingPasskey : dictionary.dfnsCreate}
        </Button>
      </div>
      {error && <p className="text-xs break-words text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

/**
 * The connect menu when no wallet is connected: the self-custody wallet
 * (the Wallets Kit modal, as before) or a Dfns policy wallet.
 */
export default function ConnectChoices({ onSelfCustody }: { onSelfCustody: () => void }) {
  const { dictionary } = useLocale();
  return (
    <div className="flex flex-col gap-3 text-sm">
      <button
        type="button"
        onClick={onSelfCustody}
        className={`w-full text-left transition-colors hover:bg-gray-50 dark:hover:bg-neutral-800 ${BOX_CLASS}`}
      >
        <ChoiceTitle
          icon={<Wallet className="mt-0.5 h-4 w-4 shrink-0" />}
          title={dictionary.connectSelfCustody}
          hint={dictionary.connectSelfCustodyHint}
        />
      </button>
      <DfnsChoice />
    </div>
  );
}
