"use client";

import { useEffect, useState } from "react";
import {
  fetchDeals,
  fetchDistributions,
  fetchTranches,
  type DealInfo,
  type DistributionsResponse,
  type TrancheInfo,
} from "@/services/registry";
import { useLocale } from "@/lib/i18n";
import { LATEST_REPORT } from "@/data/report";
import { ReportHeader } from "@/components/report/ReportHeader";
import { StatusBadges } from "@/components/report/StatusBadges";
import { ReportKpiTiles } from "@/components/report/ReportKpiTiles";
import { TrancheStructureTable } from "@/components/report/TrancheStructureTable";
import { NetLossChart } from "@/components/report/NetLossChart";
import { DelinquencyChart } from "@/components/report/DelinquencyChart";
import { LossCushionBars } from "@/components/report/LossCushionBars";
import { OnchainSection } from "@/components/report/OnchainSection";

/**
 * ABS monthly investor report (Bavarian Sky French Auto Leases 5). The
 * standard report sections render from the static IQ EQ dataset - the page
 * is complete without any backend. The "On-chain transparency" block is fed
 * live from the tranching API (30s polling, fail-soft), and the tranche
 * table links each class to its live note page when one is registered.
 */
export default function HomePage() {
  const report = LATEST_REPORT;
  const { locale } = useLocale();

  const [tranches, setTranches] = useState<TrancheInfo[] | null>(null);
  const [deals, setDeals] = useState<DealInfo[] | null>(null);
  const [distributions, setDistributions] = useState<DistributionsResponse | null>(
    null
  );

  useEffect(() => {
    let active = true;
    const load = async () => {
      const [trancheList, dealList] = await Promise.all([
        fetchTranches(),
        fetchDeals(),
      ]);
      if (!active) return;
      setTranches(trancheList);
      setDeals(dealList);
      const dealId = trancheList[0]?.dealId ?? dealList[0]?.id;
      if (dealId == null) {
        setDistributions({ distributions: [], schedule: null });
        return;
      }
      const flows = await fetchDistributions(dealId);
      if (active) setDistributions(flows);
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="py-4">
      <h2 className="sr-only">{report.srDescription[locale]}</h2>
      <ReportHeader report={report} />
      <StatusBadges badges={report.statusBadges} />
      <ReportKpiTiles report={report} />
      <TrancheStructureTable report={report} liveTranches={tranches} />
      <NetLossChart report={report} />
      <DelinquencyChart report={report} />
      <LossCushionBars report={report} />
      <OnchainSection
        report={report}
        deals={deals}
        tranches={tranches}
        distributions={distributions?.distributions ?? null}
      />
    </div>
  );
}
