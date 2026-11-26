"use client";

import { useEffect, useState } from "react";
import {
  fetchTrancheStats,
  fetchUserPositions,
  fetchTrancheHistory,
  fetchUserPositionHistory,
  type TrancheStats,
  type NotePosition,
  type TrancheHistoryPoint,
  type PositionHistoryPoint,
} from "@/services/indexer";
import { fetchNoteDenomination } from "@/services/waterfall";

const REFRESH_MS = 15_000;

// Data flows tx -> indexer cron -> API poll, so a confirmed tx can take up to
// cron+poll (~45s) to show up. Hooks subscribe here; after a confirmed tx the
// form fires a refresh burst that picks the new snapshot up within seconds.
const listeners = new Set<() => void>();
function subscribeRefresh(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function refreshNoteData(): void {
  listeners.forEach((fn) => fn());
}
/** Immediate refresh + a burst covering the indexer's next cron ticks. */
export function refreshNoteDataAfterTx(): void {
  refreshNoteData();
  [5, 12, 20, 32, 45].forEach((s) => setTimeout(refreshNoteData, s * 1000));
}

export function useTrancheStats(contractId: string) {
  const [stats, setStats] = useState<TrancheStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const s = await fetchTrancheStats(contractId);
      if (active) {
        setStats(s);
        setLoading(false);
      }
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    const unsub = subscribeRefresh(load);
    return () => {
      active = false;
      clearInterval(t);
      unsub();
    };
  }, [contractId]);

  return { stats, loading };
}

export function useTrancheHistory(contractId: string, range: string) {
  const [history, setHistory] = useState<TrancheHistoryPoint[]>([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const h = await fetchTrancheHistory(contractId, range);
      if (active) setHistory(h);
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    const unsub = subscribeRefresh(load);
    return () => {
      active = false;
      clearInterval(t);
      unsub();
    };
  }, [contractId, range]);

  return history;
}

export function useNotePositionHistory(
  contractId: string,
  address: string | null,
  range: string
) {
  const [history, setHistory] = useState<PositionHistoryPoint[]>([]);

  useEffect(() => {
    if (!address) {
      setHistory([]);
      return;
    }
    let active = true;
    const load = async () => {
      const h = await fetchUserPositionHistory(contractId, address, range);
      if (active) setHistory(h);
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    const unsub = subscribeRefresh(load);
    return () => {
      active = false;
      clearInterval(t);
      unsub();
    };
  }, [contractId, address, range]);

  return history;
}

export function useNotePosition(contractId: string, address: string | null) {
  const [position, setPosition] = useState<NotePosition | null>(null);

  useEffect(() => {
    if (!address) {
      setPosition(null);
      return;
    }
    let active = true;
    const load = async () => {
      const list = await fetchUserPositions(address);
      if (active) setPosition(list.find((p) => p.tranche === contractId) ?? null);
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    const unsub = subscribeRefresh(load);
    return () => {
      active = false;
      clearInterval(t);
      unsub();
    };
  }, [contractId, address]);

  return position;
}

/**
 * Face value of one note of the deal, in base units of the settlement asset,
 * read on chain (`get_config().note_denomination`). Null until the read
 * succeeds. A failed read runs again after REFRESH_MS.
 */
export function useNoteDenomination(dealContractId: string | null): bigint | null {
  const [result, setResult] = useState<{ dealContractId: string; denomination: bigint } | null>(
    null
  );

  useEffect(() => {
    if (!dealContractId) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const denomination = await fetchNoteDenomination(dealContractId);
      if (!active) return;
      if (denomination !== null) setResult({ dealContractId, denomination });
      else retry = setTimeout(load, REFRESH_MS);
    };
    load();
    return () => {
      active = false;
      if (retry) clearTimeout(retry);
    };
  }, [dealContractId]);

  return result && result.dealContractId === dealContractId ? result.denomination : null;
}
