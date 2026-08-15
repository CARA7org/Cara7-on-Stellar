# Anti-fraud screening

Deal: BSF5-DEMO-POOL (Bavarian Sky French Auto Leases 5, demo), cut-off date 2026-08-01. All amounts below are in EURC (pool records are loan-level EUR figures, not base units). Data sources: `get_pool`, `get_nft_registry`, `get_ipfs` (spot checks).

## Verdict

**Suspicious items found.** No VIN fraud and no double-pledge. Four flags: one delinquency misclassification (the known PERF loan with 12 days past due, confirmed as a misclassification), one systematic remaining-term overstatement across the entire 2024 vintage that inflates the reported WAM by roughly 6 months, one pervasive amortization inconsistency (principal reduced by more than total scheduled collections on 12 of 20 loans), and one caveat on the RSTR loan (the status itself is acceptable, but the record shows no post-restructuring schedule).

## Checks performed

1. **VIN integrity** (all 20 records): length 17, forbidden letters I/O/Q, duplicates, model-year code at position 10 vs `yearOfRegistration` (N = 2022, P = 2023, R = 2024).
2. **Double-pledge**: one Auto token per VIN in the NFT registry; registry VINs vs pool VINs; IPFS metadata VIN vs registry VIN spot-checked on tokens 5 and 6 (the two flagged loans).
3. **Economic outliers**: `originalLtv` > 100% and recomputed as `originalPrincipal / originalValuation`; `currentPrincipal` > `originalPrincipal`; monthly payment vs an annuity on principal/term/rate (order of magnitude, balloon-aware for LEASE/PCP); battery SoH vs vehicle age and charge cycles.
4. **Status coherence**: `accountStatus` vs `daysPastDue` vs `arrearsAmount`; cross-check against pool aggregates (`performingPercentage`, `totalArrears`). Additionally, internal date coherence: `remainingTermMonths` vs `maturityDate` vs cut-off, and principal paydown vs cumulative scheduled payments.

## Flags

**1. Misclassification: PERF status understates arrears - BSF5-2023-0006, VIN VF7C4HNZXPB617235 (Citroen e-C4).**
The record shows `accountStatus: "PERF"` with `daysPastDue: 12` and `arrearsAmount: 430`, which is exactly one missed monthly installment (`monthlyPayment: 430`). A loan with a full installment unpaid for 12 days is in arrears and belongs in a 1-30 DPD delinquency bucket, not PERF. This is a **misclassification**, not an acceptable status: PERF asserts the account is current while the same record proves it is not. It is, however, not a default (12 < 90 days). The mislabel propagates to the aggregates: `performingPercentage: 95` counts this loan as performing (19 of 20); correctly bucketed it would be 90% by contract count. Note that `totalArrears: 1030` (= 430 + 600) does include it, so the arrears counters are honest and only the status label understates the position.

**2. Systematic remaining-term overstatement: all 8 loans of the 2024 vintage - contracts BSF5-2024-0003, -0009, -0011, -0013, -0015, -0017, -0019, -0020.**
For every 2022 and 2023 loan, `remainingTermMonths` equals the months from the 2026-08-01 cut-off to `maturityDate` (e.g. BSF5-2023-0005: maturity 2027-09-05, 13.1 months, stated 13). For every 2024 loan it is overstated by 11 to 12 months. Example: BSF5-2024-0013 (WBA11EW00RC362854, BMW iX1) matures 2028-08-12, which is 24.4 months after cut-off, yet states `remainingTermMonths: 36`; BSF5-2024-0017 (KNAE781GXRS703917) matures 2029-07-01, 35.0 months out, yet states 47. The stated values correspond to an as-of date of about 2025-08, one year before the cut-off. Impact: the pool aggregate `weightedAverageMaturityMonths: 21.5` reproduces exactly from the stated per-loan values weighted by `currentPrincipal` (5,924,000 / 275,500 = 21.5), so it inherits the error; with each affected loan corrected by -12 months the WAM is 4,329,200 / 275,500 = **15.7 months**, an overstatement of about 6 months on a key investor metric.

**3. Amortization inconsistency: principal reduced by more than all scheduled collections - 12 of 20 loans.**
Principal outstanding cannot fall by more than the cash collected (and part of each payment is interest). Yet for 12 loans the reduction `originalPrincipal - currentPrincipal` exceeds `monthlyPayment x number of scheduled due dates from origination to cut-off` by more than 15%. Worst cases:
- BSF5-2024-0013: reduction 46,900 - 15,200 = 31,700 vs at most 23 payments x 580 = 13,340 collectible (originated 2024-08-12), an excess of 18,360 (+138%).
- BSF5-2024-0017: reduction 36,300 - 10,600 = 25,700 vs 25 x 420 = 10,500 (originated 2024-07-01), +145%.
- BSF5-2023-0014 (TMAK581GXPJ471520): reduction 33,500 - 9,800 = 23,700 vs 33 x 445 = 14,685, +61%.
- BSF5-2023-0006 (the loan of flag 1): reduction 30,900 - 8,100 = 22,800 vs at most 37 collected payments x 430 = 15,910 (one installment is in arrears), so the balance dropped 6,890 more than every euro collectible, on a loan that is simultaneously past due.

The other affected contracts are BSF5-2023-0007, -0010, -0016 and BSF5-2024-0003 is the only 2024 loan that passes; -0009, -0011, -0015, -0019, -0020 fail with excesses of +40% to +111%. Any single case could be voluntary prepayment, but prepayment at this scale across a majority of the pool (and concentrated in the same 2024 vintage as flag 2) is not credible. This is either a servicer data-generation error or, read adversarially, a pattern consistent with fictitious paydowns; either way the balances cannot be reconciled with the payment schedules and need explanation.

**4. RSTR loan: status acceptable, but no post-restructuring schedule - BSF5-2023-0007, VIN UU1K5200XPD709864 (Dacia Spring).**
`accountStatus: "RSTR"`, `daysPastDue: 34`, `arrearsAmount: 600` (exactly 2 x the 300 monthly payment), obligor OBL-8V2G6 (UNEM, credit band D). Decision: **acceptable status, not a misclassification**. RSTR honestly discloses forbearance, the arrears counters remain visible, and the pool's `performingPercentage: 95` correctly excludes it. The flag is the schedule data: the loan matured on 2026-07-18 (before the 2026-08-01 cut-off, `remainingTermMonths: 0`) with `currentPrincipal: 4,300` still outstanding, and `maturityDate` was never extended. A restructured loan must carry its amended terms; as recorded there is no contractual path for recovering the 4,300.

## False-positive notes

- **VIN integrity: clean.** All 20 VINs are 17 characters, contain no I/O/Q, are unique, and every position-10 year code matches `yearOfRegistration` (N for the two 2022 cars, P for the ten 2023 cars, R for the eight 2024 cars). Minor WMI oddities (WVZ... for the VW ID.3 where real ID.3s use WVWZZZE1Z; WBA for a BMW i4 where BMW i models use WBY) fall under the pool's stated "fictional serials" convention and are not flagged.
- **Double-pledge: clean.** The auto contract (CBMXM3FF...F24W) holds exactly 20 tokens, IDs 0-19, each VIN appearing once, in 1:1 correspondence with the pool. IPFS metadata for tokens 5 and 6 matches the registry VINs. Battery and obligor contracts are likewise 1:1; the pool token's `vin: null` is by design.
- **LTV and principal: clean.** Maximum `originalLtv` is 0.89 (5YJ3E7EA0RF047268); recomputing `originalPrincipal / originalValuation` matches the stated LTV within rounding on all 20 records. No loan has `currentPrincipal` above `originalPrincipal`. Aggregates recompute exactly (total financed 721,000; total current principal 275,500; monthly collections 10,630; total arrears 1,030).
- **Monthly payments: within order of magnitude.** Every payment sits between the balloon-adjusted annuity and the full-amortization annuity for its principal/term/rate (e.g. BSF5-2023-0001: 640 vs a 484-776 range), so none is flagged under the order-of-magnitude rule. The deeper balance-vs-payments inconsistency is flag 3.
- **Battery SoH: plausible throughout.** SoH declines monotonically with age and cycles, from 98.2% (2024 Model 3 Highland, 120 cycles) down to 90.6% (2022 Zoe, 540 cycles) and 91.2% (2022 Twingo, 610 cycles), consistent with normal 2-3%/year fade. No implausible values.
- **Balloon contracts below residual value: not flagged.** On 11 of 13 LEASE/PCP contracts `currentPrincipal` is below the vehicle `residualValue` (e.g. BSF5-2024-0013: 15,200 vs RV 28,700). If RV were the contractual balloon this would be systemic; since `residualValue` is vehicle market data and the contractual balloon is not recorded, this is treated as a modeling assumption gap, not an anomaly, though it overlaps with flag 3.
- **Branding note (non-fraud):** the pinned IPFS metadata still describes tokens as "TrueABS Auto Token" while the deal is branded CARA7; stale metadata, no integrity impact.
