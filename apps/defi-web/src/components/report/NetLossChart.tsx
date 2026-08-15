"use client";

import type { ReactNode } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  CartesianGrid,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  type TooltipProps,
} from "recharts";
import { gradientStops, niceScale } from "@/lib/graph";
import { useLocale } from "@/lib/i18n";
import { fmtEur, fmtEurK, fmtMonthShort, fmtPct } from "@/lib/reportFormat";
import type { MonthlyReport } from "@/data/report";

// Theme-aware grid via the shadcn border token; mockup's muted works on both.
const GRID_STROKE = "hsl(var(--border))";
const AXIS_STROKE = "#898781";
const AREA_ID = "report-loss-area";

/** Area chart of monthly net losses + the cumulative-losses footnote. */
export function NetLossChart({ report }: { report: MonthlyReport }): ReactNode {
  const { locale, dictionary } = useLocale();
  const data = report.monthlyLosses.map((point) => ({
    month: point.month,
    loss: point.lossEur,
  }));
  const maxLoss = Math.max(0, ...data.map((point) => point.loss));
  const { domain, ticks } = niceScale(0, maxLoss);

  return (
    <section className="mb-7">
      <h2 className="mb-2 text-sm font-medium">{dictionary.netLossTitle}</h2>
      <div
        className="h-[200px] w-full"
        role="img"
        aria-label={dictionary.netLossAria}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <defs>
              <linearGradient id={AREA_ID} x1="0" y1="0" x2="0" y2="1">
                {gradientStops("var(--report-accent)", 0.25, 0.05)}
              </linearGradient>
            </defs>
            {/* solid stroke, never an SVG gradient - a flat series' zero-height
                bounding box would make a gradient stroke invisible */}
            <Area
              type="monotone"
              dataKey="loss"
              stroke="var(--report-accent)"
              strokeWidth={2}
              fill={`url(#${AREA_ID})`}
              dot={{ r: 3, fill: "var(--report-accent)", strokeWidth: 0 }}
              activeDot={{ r: 4, fill: "var(--report-accent)", strokeWidth: 0 }}
              isAnimationActive={false}
            />
            <XAxis
              dataKey="month"
              interval={0}
              tickLine={false}
              tickMargin={8}
              stroke={AXIS_STROKE}
              tickFormatter={(month: string) => fmtMonthShort(locale, month)}
            />
            <YAxis
              dataKey="loss"
              width={64}
              interval={0}
              tickLine={false}
              tickMargin={8}
              stroke={AXIS_STROKE}
              domain={domain}
              ticks={ticks}
              tickFormatter={(value: number) => fmtEurK(locale, value)}
            />
            <Tooltip
              cursor={{ strokeDasharray: "4", stroke: AXIS_STROKE }}
              content={(props: TooltipProps<number, string>) => {
                if (!props.active || !props.payload?.length) return null;
                const value = props.payload[0].value ?? 0;
                return (
                  <div className="flex flex-col gap-1 rounded border border-gray-300 bg-gray-100 p-2 dark:border-neutral-700 dark:bg-neutral-950">
                    <span className="text-xs text-gray-600 dark:text-gray-400">
                      {fmtMonthShort(locale, String(props.label))}
                    </span>
                    <span className="text-sm font-semibold text-[var(--report-accent)]">
                      {fmtEur(locale, value)}
                    </span>
                  </div>
                );
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
        {dictionary.cumulativeLossFootnote(
          fmtEur(locale, report.cumulativeLosses.totalEur),
          fmtPct(locale, report.cumulativeLosses.pctOfInitialPortfolio, 2),
          fmtPct(locale, report.cumulativeLosses.pctOfReserveFund, 1)
        )}
      </p>
    </section>
  );
}
