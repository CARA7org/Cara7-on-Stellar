"use client";

import { useState, type ReactNode } from "react";
import { ExternalLink, FileText, Network, X } from "lucide-react";
import { agentReports } from "@/data/agent-reports";
import { useLocale } from "@/lib/i18n";
import { LiveDistributions } from "@/components/report/LiveDistributions";
import type { MonthlyReport } from "@/data/report";
import type { DealInfo, Distribution, TrancheInfo } from "@/services/registry";

/**
 * The Stellar-native block below the standard ABS report: contract chips,
 * live distributions, tokenised pool tiles and agent chips. The live parts
 * come from the polled registry data; the static parts from the dataset.
 */
export function OnchainSection({
  report,
  deals,
  tranches,
  distributions,
}: {
  report: MonthlyReport;
  deals: DealInfo[] | null;
  tranches: TrancheInfo[] | null;
  distributions: Distribution[] | null;
}): ReactNode {
  const { locale, dictionary } = useLocale();
  const [openReport, setOpenReport] = useState<string | null>(null);
  const dealContractId =
    deals?.find((deal) => deal.dealContractId)?.dealContractId ?? null;
  const assetSymbol = tranches?.[0]?.assetSymbol ?? "EURC";
  const assetDecimals = tranches?.[0]?.assetDecimals ?? 7;
  const chip =
    "inline-flex items-center gap-1 rounded bg-gray-100 px-2.5 py-1 text-xs text-gray-600 dark:bg-neutral-800/60 dark:text-gray-400";
  const subTitle = "mb-1.5 text-[13px] text-gray-600 dark:text-gray-400";

  return (
    <section>
      <div className="mb-3 border-t border-gray-300 pt-5 dark:border-neutral-700">
        <h2 className="text-sm font-medium">{dictionary.onchainTitle}</h2>
        <p className="mt-0.5 text-xs text-gray-500">{report.onchain.note[locale]}</p>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {dealContractId !== null && (
          <span className={`${chip} font-mono`}>
            <FileText size={13} aria-hidden />
            {dictionary.dealChip(dealContractId.slice(0, 8))}
          </span>
        )}
        <span className={chip}>
          <Network size={13} aria-hidden />
          {dictionary.stellarTestnet}
        </span>
      </div>

      <LiveDistributions
        distributions={distributions}
        assetSymbol={assetSymbol}
        assetDecimals={assetDecimals}
      />
      <p className="mb-6 text-[11px] text-gray-500">
        {report.onchain.distributionsCaveat[locale]}
      </p>

      <h3 className={subTitle}>{dictionary.poolTitle}</h3>
      <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2.5">
        {report.onchain.poolTiles.map((tile) => (
          <div key={tile.label.en} className="rounded bg-gray-100 p-3 dark:bg-neutral-800/60">
            <div className="text-xs text-gray-600 dark:text-gray-400">
              {tile.label[locale]}
            </div>
            <div className="mt-0.5 text-lg font-medium">{tile.value}</div>
            <div className="text-[11px] text-gray-500">{tile.detail[locale]}</div>
            {tile.links && (
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                {tile.links.map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-[11px] text-[var(--report-accent)] hover:underline"
                  >
                    {link.label}
                    <ExternalLink size={10} aria-hidden />
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <h3 className={subTitle}>{dictionary.agentsTitle}</h3>
      <div className="flex flex-wrap gap-1.5">
        {report.onchain.agents.map((agent) => {
          const available = agent.slug in agentReports;
          if (!available) {
            return (
              <span
                key={agent.slug}
                title={dictionary.reportPending}
                className="rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-400 dark:bg-neutral-800/40 dark:text-gray-600"
              >
                {agent.name[locale]}
              </span>
            );
          }
          return (
            <button
              key={agent.slug}
              onClick={() => setOpenReport(agent.slug)}
              title={dictionary.viewReport}
              className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-200 dark:bg-neutral-800/60 dark:text-gray-300 dark:hover:bg-neutral-700"
            >
              <FileText size={11} aria-hidden />
              {agent.name[locale]}
            </button>
          );
        })}
      </div>

      {openReport !== null && agentReports[openReport] && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setOpenReport(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl dark:bg-neutral-900"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-neutral-800">
              <div>
                <h4 className="text-sm font-medium">
                  {report.onchain.agents.find((agent) => agent.slug === openReport)?.name[
                    locale
                  ] ?? openReport}
                </h4>
                <p className="text-[11px] text-gray-500">
                  {dictionary.reportGeneratedOn(
                    new Date(agentReports[openReport].generatedAt).toLocaleDateString(
                      locale === "fr" ? "fr-FR" : "en-GB",
                      { day: "numeric", month: "short", year: "numeric" }
                    )
                  )}
                </p>
              </div>
              <button
                onClick={() => setOpenReport(null)}
                aria-label={dictionary.close}
                className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-neutral-800"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            <pre className="overflow-y-auto whitespace-pre-wrap px-4 py-3 font-sans text-xs leading-relaxed text-gray-800 dark:text-gray-200">
              {agentReports[openReport].markdown}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}
