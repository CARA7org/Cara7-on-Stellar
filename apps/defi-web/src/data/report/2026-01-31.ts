import type { MonthlyReport } from "./types";

/**
 * Bavarian Sky French Auto Leases 5 - monthly investor report, cut-off
 * 2026-01-31 (real IQ EQ data). Values mirror the EN/FR dashboard mockups;
 * localized prose is verbatim from them.
 */
export const REPORT_2026_01_31: MonthlyReport = {
  cutoffDate: "2026-01-31",
  paymentDate: "2026-02-20",
  dealName: "Bavarian Sky French Auto Leases 5",
  subtitle: {
    en: "French FCT · Class A/B/C Notes backed by BMW auto lease receivables · tokenised on Stellar",
    fr: "FCT loi française · Notes Classe A/B/C adossées à des créances de location automobile BMW · tokenisé sur Stellar",
  },
  srDescription: {
    en: "Investor report for the Bavarian Sky French Auto Leases 5 securitisation, combining ABS market-standard tranche reporting with on-chain transparency from the Stellar tokenisation layer",
    fr: "Reporting investisseur pour la titrisation Bavarian Sky French Auto Leases 5, combinant les indicateurs ABS standards du marché avec la transparence on-chain de la couche de tokenisation Stellar",
  },
  statusBadges: [
    { en: "No Enforcement Event", fr: "Aucun Enforcement Event" },
    {
      en: "BMW AG rating trigger not breached",
      fr: "Trigger de notation BMW AG non déclenché",
    },
    { en: "No Interest Shortfall", fr: "Aucun Interest Shortfall" },
  ],
  portfolio: {
    outstandingEur: 574_300_000,
    momChangePct: -1.76,
    notesOutstandingEur: 560_400_000,
    initialIssuanceEur: 643_300_000,
    reserveFundEur: 5_150_000,
    reserveFundPctOfRequired: 100,
    netLossMonthPct: 0.06,
    netLossRolling3mPct: 0.04,
  },
  tranches: [
    {
      classLetter: "A",
      label: "A · Senior",
      seniority: "SENIOR",
      initialBalanceEur: 500_000_000,
      currentBalanceEur: 417_100_000,
      rate: { kind: "floating", index: "E1M", spreadPct: 0.6, floorPct: 0 },
      creditEnhancementPct: 23.1,
      factorPct: 83.4,
    },
    {
      classLetter: "B",
      label: "B · Mezzanine",
      seniority: "MEZZANINE",
      initialBalanceEur: 68_900_000,
      currentBalanceEur: 68_900_000,
      rate: { kind: "fixed", ratePct: 1.0 },
      creditEnhancementPct: 12.4,
      factorPct: 100,
    },
    {
      classLetter: "C",
      label: "C · Junior",
      seniority: "JUNIOR",
      initialBalanceEur: 74_400_000,
      currentBalanceEur: 74_400_000,
      rate: { kind: "fixed", ratePct: 1.5 },
      creditEnhancementPct: 0.8,
      factorPct: 100,
    },
  ],
  monthlyLosses: [
    { month: "2025-07", lossEur: 10_281 },
    { month: "2025-08", lossEur: 14_052 },
    { month: "2025-09", lossEur: 9_650 },
    { month: "2025-10", lossEur: 64_897 },
    { month: "2025-11", lossEur: 62_404 },
    { month: "2025-12", lossEur: 243_096 },
    { month: "2026-01", lossEur: 342_505 },
  ],
  cumulativeLosses: {
    totalEur: 746_886,
    pctOfInitialPortfolio: 0.12,
    pctOfReserveFund: 14.5,
  },
  delinquency: {
    buckets: [
      { bucket: "31-60", pctOfPortfolio: 0.16, contracts: 21 },
      { bucket: "61-90", pctOfPortfolio: 0.1, contracts: 20 },
      { bucket: ">90", pctOfPortfolio: 0.14, contracts: 17 },
    ],
    totalPct: 0.4,
    totalContracts: 58,
  },
  lossCushions: [
    {
      classLetter: "C",
      seniority: "JUNIOR",
      creditEnhancementPct: 0.8,
      reserveOnly: true,
      usedEur: 746_886,
      totalEur: 5_150_000,
    },
    {
      classLetter: "B",
      seniority: "MEZZANINE",
      creditEnhancementPct: 12.4,
      reserveOnly: false,
      usedEur: 746_886,
      totalEur: 79_550_000,
    },
    {
      classLetter: "A",
      seniority: "SENIOR",
      creditEnhancementPct: 23.1,
      reserveOnly: false,
      usedEur: 746_886,
      totalEur: 148_450_000,
    },
  ],
  onchain: {
    note: {
      en: "Carried over from the current /reporting endpoint - Stellar-native, not part of a standard ABS report.",
      fr: "Repris de l'endpoint /reporting actuel - spécifique à Stellar, sans équivalent dans un reporting ABS classique.",
    },
    distributionsCaveat: {
      en: "Demo-pool distributions (POC testnet cadence), shown alongside - not a substitute for - the real monthly IQ EQ figures above.",
      fr: "Distributions du pool de démo (cadence testnet du POC), affichées en complément - et non en remplacement - des vrais chiffres mensuels IQ EQ ci-dessus.",
    },
    poolTiles: [
      {
        label: { en: "NFTs minted", fr: "NFT émis" },
        value: "61",
        detail: {
          en: "20 auto + 20 battery + 20 obligor + 1 pool",
          fr: "20 auto + 20 batterie + 20 débiteur + 1 pool",
        },
        links: [
          { label: "auto", url: "https://stellar.expert/explorer/testnet/contract/CBMXM3FFALISGE5LV263UE6WVSFT6UYEIADTHHH62UBP2MYVEYQ4F24W" },
          { label: "battery", url: "https://stellar.expert/explorer/testnet/contract/CAVZYMDU35SVPUTU2IIPXAZTV2JHFQJEFY3BBF5MHJE33UXW5V24UM2R" },
          { label: "obligor", url: "https://stellar.expert/explorer/testnet/contract/CDFIZNYMXWZEW4TSVJ5URW2U4YVNM6RP7RNMJ2TBUR57VKTZEOCXGJFU" },
          { label: "pool", url: "https://stellar.expert/explorer/testnet/contract/CCTXVNGH34IUY763EVKF6EZ2LJYXHROWNKUN3W4ZEVL6ADKTLPADGXT7" },
        ],
      },
      {
        label: { en: "Avg. battery SoH", fr: "SoH batterie moyen" },
        value: "~88%*",
        detail: {
          en: "*illustrative, no real EV pool data",
          fr: "*illustratif, pas de vraie donnée pool EV",
        },
      },
      {
        label: { en: "Metadata anchoring", fr: "Ancrage métadonnées" },
        value: "IPFS",
        detail: { en: "ESMA AUTL-style records", fr: "Fiches type ESMA AUTL" },
      },
    ],
    agents: [
      { slug: "accounting", name: { en: "Accounting", fr: "Comptabilité" } },
      { slug: "anti-fraud", name: { en: "Anti-fraud", fr: "Anti-fraude" } },
      { slug: "calculation", name: { en: "Calculation", fr: "Calcul" } },
      { slug: "compliance", name: { en: "Compliance", fr: "Conformité" } },
      { slug: "data-custody", name: { en: "Data custody", fr: "Data custody" } },
      { slug: "interest-determination", name: { en: "Interest determination", fr: "Détermination des intérêts" } },
      { slug: "paying", name: { en: "Paying", fr: "Paiement" } },
      { slug: "rse", name: { en: "RSE", fr: "RSE" } },
      { slug: "audit", name: { en: "Audit", fr: "Audit" } },
      { slug: "verifier", name: { en: "Verifier", fr: "Vérificateur" } },
    ],
  },
};
