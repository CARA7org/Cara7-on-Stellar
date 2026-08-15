"use client";

import { useEffect, useState } from "react";
import { fetchNoteEvents, type NoteEvent } from "@/services/indexer";
import { formatQty } from "@/lib/format";
import { useLocale, type Dictionary, type Locale } from "@/lib/i18n";

/**
 * On-chain activity feed, inspired by the CARA7 dashboard mockup's
 * "Audit trail - immutable, event-sourced" panel. Events come from the
 * indexer (getEvents ingestion), so every line is a real ledger event.
 * A class's life spans three contracts - the note token (issue/transfer),
 * the abs-deal (subscriptions, waterfall ranks) and the paying agent
 * (pushes/claims) - so the feed merges all of them. Labels live in the
 * locale dictionary (`eventLabels`); only the dot colors live here.
 */
const EVENT_COLOR: Record<string, string> = {
  subscribed: "#10B981",
  sub_cancelled: "#F97316",
  deal_closed: "#8B5CF6",
  issue: "#10B981",
  transfer: "#8B5CF6",
  distribution: "#3B82F6",
  interest_paid: "#10B981",
  principal_paid: "#0EA5E9",
  factor_updated: "#6366F1",
  reserve_released: "#F59E0B",
  reserve_refunded: "#F59E0B",
  period_funded: "#3B82F6",
  holder_paid: "#10B981",
  push_failed: "#EF4444",
  claimed: "#0EA5E9",
  enforced: "#EF4444",
  matured: "#8B5CF6",
};

function dataArray(event: NoteEvent): string[] {
  return Array.isArray(event.data)
    ? (event.data as unknown[]).map(String)
    : [String(event.data)];
}

function amountOf(value: string | undefined, decimals: number): number {
  const n = Number(value ?? "0");
  return Number.isFinite(n) ? n / 10 ** decimals : 0;
}

/**
 * Human detail line per event type. Layouts mirror the contractevent structs
 * (data_format = "vec": topics [type, ...], data = non-topic fields in
 * struct order) - see tranching-api src/decode.ts.
 */
function eventDetail(
  event: NoteEvent,
  symbol: string,
  decimals: number,
  dictionary: Dictionary
): string | null {
  const data = dataArray(event);
  switch (event.type) {
    case "subscribed":
    case "sub_cancelled":
      // data [class, notes, amount]
      return dictionary.eventSubscription(
        data[1] ?? "0",
        formatQty(amountOf(data[2], decimals)),
        symbol
      );
    case "deal_closed":
      // data [proceeds_to_seller, reserve, period_start_ts]
      return dictionary.eventToSeller(formatQty(amountOf(data[0], decimals)), symbol);
    case "issue":
    case "transfer":
      // note-token: data [notes] (decimals 0)
      return dictionary.eventNotes(data[0] ?? "0");
    case "distribution":
      // data [collections, reserve_released, carry_in, ada]
      return dictionary.eventAda(formatQty(amountOf(data[3], decimals)), symbol);
    case "interest_paid":
      // data [period, due, paid, shortfall, dust]
      return `${formatQty(amountOf(data[2], decimals))} ${symbol}`;
    case "principal_paid":
      // data [period, paid, per_note, outstanding_after]
      return `${formatQty(amountOf(data[1], decimals))} ${symbol}`;
    case "factor_updated":
      // data [period, factor, per_note_outstanding] - FACTOR_SCALE 1e7
      return `${(Number(data[1] ?? "0") / 100_000).toFixed(3)}%`;
    case "reserve_released":
    case "reserve_refunded":
      // data [amount, ...]
      return `${formatQty(amountOf(data[0], decimals))} ${symbol}`;
    case "period_funded":
      // data [class, interest, principal, per_note_principal]
      return `${formatQty(amountOf(data[1], decimals) + amountOf(data[2], decimals))} ${symbol}`;
    case "holder_paid":
      // data [period, class, interest, principal]
      return `${formatQty(amountOf(data[2], decimals) + amountOf(data[3], decimals))} ${symbol}`;
    case "push_failed":
      // data [period, class, amount]
      return `${formatQty(amountOf(data[2], decimals))} ${symbol}`;
    case "claimed":
      // data [class, interest, principal]
      return `${formatQty(amountOf(data[1], decimals) + amountOf(data[2], decimals))} ${symbol}`;
    default:
      return null;
  }
}

const MAX_ROWS = 10;
const INTL_LOCALE: Record<Locale, string> = { en: "en-GB", fr: "fr-FR" };

export function AuditTrail({
  contractIds,
  symbol,
  decimals,
}: {
  contractIds: string[];
  symbol: string;
  decimals: number;
}) {
  const { locale, dictionary } = useLocale();
  const [events, setEvents] = useState<NoteEvent[] | null>(null);
  const idsKey = contractIds.join(",");

  useEffect(() => {
    const ids = idsKey.split(",").filter(Boolean);
    if (ids.length === 0) return;
    let active = true;
    const load = async () => {
      const lists = await Promise.all(ids.map((id) => fetchNoteEvents(id, MAX_ROWS)));
      if (!active) return;
      // Event ids are fixed-width zero-padded TOIDs: lexicographic order
      // equals chronological order (no BigInt - ids contain a dash).
      const merged = lists
        .flat()
        .sort((a, b) => b.ledger - a.ledger || b.id.localeCompare(a.id))
        .slice(0, MAX_ROWS);
      setEvents(merged);
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [idsKey]);

  const labels = dictionary.eventLabels as Record<string, string>;

  return (
    <div className="rounded border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-lg font-semibold">{dictionary.auditTitle}</h3>
        <span className="text-xs text-gray-500">{dictionary.auditSubtitle}</span>
      </div>
      {(!events || events.length === 0) && (
        <p className="mt-3 text-sm text-gray-500">{dictionary.auditEmpty}</p>
      )}
      <ul className="mt-3 flex flex-col">
        {(events ?? []).map((event) => {
          const label = labels[event.type] ?? event.type;
          const color = EVENT_COLOR[event.type] ?? "#6B7280";
          const detail = eventDetail(event, symbol, decimals, dictionary);
          return (
            <li
              key={event.id}
              className="flex items-start gap-3 border-l border-gray-200 dark:border-neutral-800 py-2 pl-4"
            >
              <span
                className="mt-1.5 h-2 w-2 shrink-0 -translate-x-[21px] rounded-full"
                style={{ backgroundColor: color }}
              />
              <div className="-ml-4 flex flex-1 flex-col">
                <span className="text-sm font-medium">{label}</span>
                {detail && (
                  <span className="text-xs text-gray-600 dark:text-gray-400">
                    {detail}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end text-xs text-gray-500">
                <span>
                  {new Date(event.ts).toLocaleDateString(INTL_LOCALE[locale], {
                    day: "2-digit",
                    month: "short",
                  })}{" "}
                  {new Date(event.ts).toLocaleTimeString(INTL_LOCALE[locale], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className="font-mono">{dictionary.auditLedger(event.ledger)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
