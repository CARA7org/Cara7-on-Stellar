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
import { useTrancheHistory } from "@/hooks/useNoteData";
import { formatCompact } from "@/lib/format";
import { useLocale } from "@/lib/i18n";

// Chart theme (globals.css .dark): grid --stroke-secondary, axes --container-border.
const GRID_STROKE = "hsl(0, 0%, 35%)";
const AXIS_STROKE = "hsl(0, 0%, 45%)";

type GraphType = "outstanding" | "noteFactor";
type Period = "7d" | "30d" | "90d" | "all";

const PERIODS: Period[] = ["7d", "30d", "90d", "all"];

const AREA_ID = "tranche-outstanding-area";

function fmtValue(type: GraphType, v: number): string {
  if (type === "noteFactor") return `${v.toFixed(3)}%`;
  return formatCompact(v);
}

export function TrancheChart({
  contractId,
  symbol,
  decimals,
}: {
  contractId: string;
  symbol: string;
  decimals: number;
}) {
  const { dictionary } = useLocale();
  const [type, setType] = useState<GraphType>("outstanding");
  const [period, setPeriod] = useState<Period>("30d");
  const history = useTrancheHistory(contractId, period);

  const types: { k: GraphType; label: string; info: string }[] = [
    {
      k: "outstanding",
      label: dictionary.chartOutstanding,
      info: dictionary.chartOutstandingInfo,
    },
    {
      k: "noteFactor",
      label: dictionary.chartNoteFactor,
      info: dictionary.chartNoteFactorInfo,
    },
  ];

  const data = history.map((h) => ({
    ts: Math.floor(new Date(h.ts).getTime() / 1000),
    value:
      type === "outstanding"
        ? Number(BigInt(h.outstanding)) / 10 ** decimals
        : h.noteFactorPct,
  }));

  const values = data.map((d) => d.value);
  const minY = values.length ? Math.min(...values) : 0;
  const maxY = values.length ? Math.max(...values) : 0;
  const last = data.length ? data[data.length - 1] : null;

  // Round domain + round ticks (Heckbert nice-numbers).
  const { domain: yDomain, ticks: yTicks } = niceScale(minY, maxY);

  // Adapt the x-axis to the actual span: a fresh deal covers hours/days, the
  // longer views cover weeks - never repeat the same DD/MM across ticks.
  const spanDays =
    data.length > 1 ? (data[data.length - 1].ts - data[0].ts) / 86_400 : 0;
  const xPattern = spanDays <= 10 ? "D MMM HH:mm" : "D MMM";
  const xFmt = (t: number) => dayjs.unix(t).format(xPattern);
  const tipFmt = (t: number) =>
    dayjs.unix(t).format(spanDays <= 10 ? "D MMM HH:mm" : "D MMM YYYY");

  const info = types.find((t) => t.k === type)?.info ?? "";

  const btn = (active: boolean) =>
    `px-3 py-1 rounded-full text-sm transition-colors ${
      active ? "bg-white shadow-sm text-gray-900 dark:bg-[#475569] dark:text-gray-100" : "text-gray-500 dark:text-gray-400"
    }`;

  return (
    <div className="rounded border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      {/* type + period selectors */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 p-1 rounded-full bg-gray-200 dark:bg-[#2a3142]">
            {types.map((t) => (
              <button key={t.k} onClick={() => setType(t.k)} className={btn(type === t.k)}>
                {t.label}
              </button>
            ))}
          </div>
          {/* hover for the metric's definition - styled tooltip, not the
              native `title` attr (1s delay, unstyled → feels broken) */}
          <span className="relative group flex items-center justify-center w-5 h-5 text-xs italic border rounded-full cursor-help text-gray-600 dark:text-gray-400 border-gray-400 dark:border-neutral-600">
            i
            <span className="absolute top-7 left-1/2 -translate-x-1/2 z-10 hidden group-hover:block w-64 p-2 text-xs not-italic text-left rounded border border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-950 text-gray-700 dark:text-gray-300">
              {info}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1 p-1 rounded-full bg-gray-200 dark:bg-[#2a3142]">
          {PERIODS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)} className={`${btn(period === p)} uppercase`}>
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="w-full h-[266px] mt-4">
        {data.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-gray-500">
            {dictionary.chartNoHistory}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <defs>
                <linearGradient id={AREA_ID} x1="0" y1="0" x2="0" y2="1">
                  {gradientStops(AREA_COLOR, 0.6, 0.2)}
                </linearGradient>
              </defs>
              {/* solid stroke, not a gradient: a flat line's bounding box has
                  zero height and a gradient stroke would render invisible. */}
              <Area
                type="monotone"
                dataKey="value"
                strokeWidth={2}
                fill={`url(#${AREA_ID})`}
                stroke={LINE_COLOR}
              />
              {/* live marker: right after a distribution the new level is
                  sub-pixel wide on a multi-day axis, so pin the latest value. */}
              {last && (
                <ReferenceDot
                  x={last.ts}
                  y={last.value}
                  r={4}
                  fill={LINE_COLOR}
                  stroke={SURFACE_COLOR}
                  strokeWidth={2}
                  isFront
                  label={currentValueLabel(
                    `${fmtValue(type, last.value)}${type === "outstanding" ? ` ${symbol}` : ""}`
                  )}
                />
              )}
              <XAxis
                dataKey="ts"
                tickMargin={8}
                minTickGap={60}
                tickLine={false}
                stroke={AXIS_STROKE}
                tickFormatter={xFmt}
              />
              <YAxis
                dataKey="value"
                tickMargin={8}
                width={64}
                tickLine={false}
                stroke={AXIS_STROKE}
                domain={yDomain}
                ticks={yTicks}
                interval={0}
                tickFormatter={(t: number) =>
                  type === "noteFactor" ? `${t.toFixed(1)}%` : formatCompact(t)
                }
              />
              <Tooltip
                cursor={{ strokeDasharray: "4", stroke: AXIS_STROKE }}
                content={(p: TooltipProps<number, string>) => {
                  if (!p.active || !p.payload?.length) return null;
                  const v = p.payload[0].value ?? 0;
                  const date = tipFmt(p.label as number);
                  return (
                    <div className="flex flex-col gap-1 p-2 rounded border border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-950">
                      <span className="text-xs text-gray-600 dark:text-gray-400">{date}</span>
                      <span className="text-sm font-semibold" style={{ color: LINE_COLOR }}>
                        {fmtValue(type, v)}
                        {type === "outstanding" ? ` ${symbol}` : ""}
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
