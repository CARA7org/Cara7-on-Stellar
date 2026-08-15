"use client";

import { useState } from "react";
import dayjs from "dayjs";
import {
  ResponsiveContainer,
  AreaChart,
  CartesianGrid,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceDot,
  type TooltipProps,
} from "recharts";
import {
  gradientStops,
  niceScale,
  currentValueLabel,
  LINE_COLOR,
  AREA_COLOR,
  SURFACE_COLOR,
} from "@/lib/graph";
import { useNotePositionHistory } from "@/hooks/useNoteData";
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { formatQty, formatCompact } from "@/lib/format";
import { useLocale } from "@/lib/i18n";

const GRID_STROKE = "hsl(0, 0%, 35%)";
const AXIS_STROKE = "hsl(0, 0%, 45%)";
const CLAIM_AREA_ID = "position-claim-area";
const RECEIVED_AREA_ID = "position-received-area";
// Second series (cash received) - emerald, distinct from the claim line.
const RECEIVED_COLOR = "#10B981";

type Period = "7d" | "30d" | "90d" | "all";
const PERIODS: Period[] = ["7d", "30d", "90d", "all"];

/**
 * Remaining claim of the position over time (notes held × per-note
 * outstanding) with the cumulative cash received (interest + principal,
 * pushed by the paying agent) as a second series.
 */
export function UserPositionChart({
  contractId,
  symbol,
  decimals,
}: {
  contractId: string;
  symbol: string;
  decimals: number;
}) {
  const address = useStellarWalletStore((s) => s.address);
  const { dictionary } = useLocale();
  const [period, setPeriod] = useState<Period>("30d");
  const history = useNotePositionHistory(contractId, address, period);

  const data = history.map((h) => ({
    ts: Math.floor(new Date(h.ts).getTime() / 1000),
    claim: h.value / 10 ** decimals,
    received: h.receivedCum / 10 ** decimals,
  }));

  const values = data.flatMap((d) => [d.claim, d.received]);
  const minY = values.length ? Math.min(...values) : 0;
  const maxY = values.length ? Math.max(...values) : 0;
  const last = data.length ? data[data.length - 1] : null;
  const { domain: yDomain, ticks: yTicks } = niceScale(minY, maxY);

  const spanDays =
    data.length > 1 ? (data[data.length - 1].ts - data[0].ts) / 86_400 : 0;
  const xPattern = spanDays <= 10 ? "D MMM HH:mm" : "D MMM";

  const btn = (active: boolean) =>
    `px-3 py-1 rounded-full text-sm transition-colors ${
      active ? "bg-white shadow-sm text-gray-900 dark:bg-[#475569] dark:text-gray-100" : "text-gray-500 dark:text-gray-400"
    }`;

  return (
    <div className="rounded border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">{dictionary.positionChartTitle}</h3>
        <div className="flex items-center gap-1 p-1 rounded-full bg-gray-200 dark:bg-[#2a3142]">
          {PERIODS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)} className={`${btn(period === p)} uppercase`}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* series legend */}
      <div className="mt-2 flex items-center gap-4 text-xs text-gray-600 dark:text-gray-400">
        <span className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: LINE_COLOR }}
          />
          {dictionary.legendRemainingClaim}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: RECEIVED_COLOR }}
          />
          {dictionary.legendCashReceived}
        </span>
      </div>

      <div className="w-full h-[220px] mt-4">
        {data.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-gray-500">
            {address ? dictionary.chartNoHistory : dictionary.chartConnectWallet}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <defs>
                <linearGradient id={CLAIM_AREA_ID} x1="0" y1="0" x2="0" y2="1">
                  {gradientStops(AREA_COLOR, 0.6, 0.2)}
                </linearGradient>
                <linearGradient id={RECEIVED_AREA_ID} x1="0" y1="0" x2="0" y2="1">
                  {gradientStops(RECEIVED_COLOR, 0.35, 0.05)}
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="claim"
                strokeWidth={2}
                fill={`url(#${CLAIM_AREA_ID})`}
                stroke={LINE_COLOR}
              />
              <Area
                type="monotone"
                dataKey="received"
                strokeWidth={2}
                fill={`url(#${RECEIVED_AREA_ID})`}
                stroke={RECEIVED_COLOR}
              />
              {/* live marker: right after a payment the new level is sub-pixel
                  wide on a multi-day axis, so pin the latest claim value. */}
              {last && (
                <ReferenceDot
                  x={last.ts}
                  y={last.claim}
                  r={4}
                  fill={LINE_COLOR}
                  stroke={SURFACE_COLOR}
                  strokeWidth={2}
                  isFront
                  label={currentValueLabel(`${formatQty(last.claim)} ${symbol}`)}
                />
              )}
              <XAxis
                dataKey="ts"
                tickMargin={8}
                minTickGap={60}
                tickLine={false}
                stroke={AXIS_STROKE}
                tickFormatter={(t: number) => dayjs.unix(t).format(xPattern)}
              />
              <YAxis
                tickMargin={8}
                width={64}
                tickLine={false}
                stroke={AXIS_STROKE}
                domain={yDomain}
                ticks={yTicks}
                interval={0}
                tickFormatter={(t: number) => formatCompact(t)}
              />
              <Tooltip
                cursor={{ strokeDasharray: "4", stroke: AXIS_STROKE }}
                content={(p: TooltipProps<number, string>) => {
                  if (!p.active || !p.payload?.length) return null;
                  const claim = p.payload.find((s) => s.dataKey === "claim")?.value ?? 0;
                  const received =
                    p.payload.find((s) => s.dataKey === "received")?.value ?? 0;
                  const date = dayjs
                    .unix(p.label as number)
                    .format(spanDays <= 10 ? "D MMM HH:mm" : "D MMM YYYY");
                  return (
                    <div className="flex flex-col gap-1 p-2 rounded border border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-950">
                      <span className="text-xs text-gray-600 dark:text-gray-400">{date}</span>
                      <span className="text-sm font-semibold" style={{ color: LINE_COLOR }}>
                        {dictionary.tooltipClaim} {formatQty(claim)} {symbol}
                      </span>
                      <span className="text-sm font-semibold" style={{ color: RECEIVED_COLOR }}>
                        {dictionary.tooltipReceived} {formatQty(received)} {symbol}
                      </span>
                    </div>
                  );
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
