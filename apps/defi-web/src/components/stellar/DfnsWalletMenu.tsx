"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TxFeedback } from "@/components/TxFeedback";
import { useDealAssetId, useDfnsTrustline } from "@/hooks/useDfnsTrustline";
import { useTxRunner } from "@/hooks/useTxRunner";
import { useLocale } from "@/lib/i18n";
import { canRemoveTrustline, removeTrustline } from "@/services/trustline";
import useStellarWalletStore from "@/stores/useStellarWalletStore";

/**
 * The menu of a connected Dfns wallet: the address, the investor name and
 * the logout action. When the wallet holds an empty EURC trustline, the
 * menu also offers to remove it. Then a paying-agent push to the wallet
 * fails and the payment waits for a claim.
 */
export default function DfnsWalletMenu({
  address,
  shortAddress,
  onLogout,
}: {
  address: string;
  shortAddress: string;
  onLogout: () => void;
}) {
  const { dictionary } = useLocale();
  const investorName = useStellarWalletStore((s) => s.investorName);
  const tokenContractId = useDealAssetId();
  const { asset, state } = useDfnsTrustline(tokenContractId, address, "dfns");
  const { submitting, status, busyLabel, run } = useTxRunner();

  const symbol = asset?.code ?? "EURC";
  const removable = tokenContractId !== null && canRemoveTrustline(state);

  const handleRemove = async () => {
    if (!tokenContractId) return;
    await run((options) => removeTrustline({ tokenContractId, address }, options));
  };

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-row items-center justify-between gap-2">
        <div className="flex flex-1 items-center gap-2">
          <span>{shortAddress}</span>
          <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-900 dark:bg-purple-950/60 dark:text-purple-200">
            Dfns
          </span>
        </div>
        <button
          onClick={onLogout}
          className="p-1 rounded transition-colors"
          aria-label={dictionary.logout}
          title={dictionary.logout}
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
      {investorName && (
        <p className="text-xs text-gray-500">{dictionary.dfnsSignedInAs(investorName)}</p>
      )}

      {(removable || status) && (
        <div className="mt-1 flex flex-col gap-2 border-t border-gray-200 pt-2 dark:border-neutral-800">
          {removable && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRemove}
                disabled={submitting}
                className="w-full rounded-full"
              >
                {submitting ? busyLabel : dictionary.removeTrustline(symbol)}
              </Button>
              <p className="text-xs text-gray-500">{dictionary.removeTrustlineHint(symbol)}</p>
            </>
          )}
          <TxFeedback status={status} />
        </div>
      )}
    </div>
  );
}
