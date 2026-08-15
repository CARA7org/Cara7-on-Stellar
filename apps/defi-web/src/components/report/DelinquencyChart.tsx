"use client";

import type { ReactNode } from "react";
import {
  ResponsiveContainer,
  BarChart,
  CartesianGrid,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  type TooltipProps,
} from "recharts";
import { niceScale } from "@/lib/graph";
import { useLocale, type Dictionary } from "@/lib/i18n";
import { fmtPct } from "@/lib/reportFormat";
import type { DelinquencyBucketId, MonthlyReport } from "@/data/report";

const GRID_STROKE = "hsl(var(--border))";
const AXIS_STROKE = "#898781";

function bucketLabel(dictionary: Dictionary, bucket: DelinquencyBucketId): string {
  if (bucket === "31-60") return dictionary.bucket31_60;
  if (bucket === "61-90") return dictionary.bucket61_90;
  return dictionary.bucketOver90;
}

/** Horizontal bars of delinquencies per ageing bucket, in % of portfolio. */
export function DelinquencyChart({ report }: { report: MonthlyReport }): ReactNode {
  const { locale, dictionary } = useLocale();
  const data = report.delinquency.buckets.map((bucket) => ({
    bucket: bucket.bucket,
    pct: bucket.pctOfPortfolio,
    contracts: bucket.contracts,
  }));
  const maxPct = Math.max(0, ...data.map((point) => point.pct));
  const { domain, ticks } = niceScale(0, maxPct, 5);

  return (
    <section className="mb-7">
      <h2 className="mb-2 text-sm font-medium">{dictionary.delinquencyTitle}</h2>
      <div
        className="h-[180px] w-full"
        role="img"
        aria-label={dictionary.delinquencyAria}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid stroke={GRID_STROKE} horizontal={false} />
            <XAxis
              type="number"
              tickLine={false}
              tickMargin={8}
              stroke={AXIS_STROKE}
              domain={domain}
              ticks={ticks}
              interval={0}
              tickFormatter={(value: number) =>
                fmtPct(locale, value, Number.isInteger(value) ? 0 : 2)
              }
            />
            <YAxis
              type="category"
              dataKey="bucket"
              width={110}
              tickLine={false}
              stroke={AXIS_STROKE}
              tickFormatter={(bucket: DelinquencyBucketId) =>
                bucketLabel(dictionary, bucket)
              }
            />
            <Bar
              dataKey="pct"
              fill="var(--chart-delinquency)"
              radius={[0, 4, 4, 0]}
              maxBarSize={40}
              isAnimationActive={false}
            />
            <Tooltip
              cursor={false}
              content={(props: TooltipProps<number, string>) => {
                if (!props.active || !props.payload?.length) return null;
                const point = props.payload[0].payload as {
                  bucket: DelinquencyBucketId;
                  pct: number;
                  contracts: number;
                };
                return (
                  <div className="flex flex-col gap-1 rounded border border-gray-300 bg-gray-100 p-2 dark:border-neutral-700 dark:bg-neutral-950">
                    <span className="text-xs text-gray-600 dark:text-gray-400">
                      {bucketLabel(dictionary, point.bucket)}
                    </span>
                    <span className="text-sm font-semibold text-[var(--chart-delinquency)]">
                      {dictionary.delinquencyValue(
                        fmtPct(locale, point.pct, 2),
                        point.contracts
                      )}
                    </span>
                  </div>
                );
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="sr-only">
        {dictionary.delinquencyTotal(
          fmtPct(locale, report.delinquency.totalPct, 2),
          report.delinquency.totalContracts
        )}
      </p>
    </section>
  );
}
