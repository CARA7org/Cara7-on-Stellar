"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProviderId } from "@/services/signers/types";
import { fetchTranches } from "@/services/registry";
import {
  fetchClassicAsset,
  fetchTrustline,
  onTrustlineChange,
  type ClassicAsset,
  type TrustlineState,
} from "@/services/trustline";

interface TrustlineView {
  asset: ClassicAsset | null;
  /** Null while unknown, and for a wallet that is not a Dfns wallet. */
  state: TrustlineState | null;
}

/**
 * The trustline of the deal asset for a connected Dfns wallet. A
 * self-custody wallet manages its own trustlines, so the state stays null
 * for it. The view refreshes after each trustline change in the app.
 */
export function useDfnsTrustline(
  tokenContractId: string | null,
  address: string | null,
  provider: ProviderId | null
): TrustlineView & { refresh: () => void } {
  const key =
    provider === "dfns" && address && tokenContractId ? `${tokenContractId}:${address}` : null;
  const [result, setResult] = useState<(TrustlineView & { key: string }) | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => onTrustlineChange(refresh), [refresh]);

  useEffect(() => {
    if (!key || !tokenContractId || !address) return;
    let active = true;
    (async () => {
      const asset = await fetchClassicAsset(tokenContractId);
      const state = asset ? await fetchTrustline(address, asset) : null;
      if (active) setResult({ key, asset, state });
    })();
    return () => {
      active = false;
    };
  }, [key, tokenContractId, address, version]);

  const current = result && result.key === key ? result : null;
  return { asset: current?.asset ?? null, state: current?.state ?? null, refresh };
}

let dealAssetPromise: Promise<string | null> | null = null;

/** The token contract of the deal asset (EURC), from the tranche registry. */
function fetchDealAssetId(): Promise<string | null> {
  if (!dealAssetPromise) {
    dealAssetPromise = fetchTranches().then((tranches) => {
      const tranche = tranches.find((t) => t.assetSymbol === "EURC") ?? tranches[0];
      if (!tranche) dealAssetPromise = null; // the registry did not answer: try again later
      return tranche?.baseAssetId ?? null;
    });
  }
  return dealAssetPromise;
}

/** The deal asset contract id, for views that are not tied to one tranche (the header). */
export function useDealAssetId(): string | null {
  const [assetId, setAssetId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    fetchDealAssetId().then((id) => {
      if (active) setAssetId(id);
    });
    return () => {
      active = false;
    };
  }, []);
  return assetId;
}
