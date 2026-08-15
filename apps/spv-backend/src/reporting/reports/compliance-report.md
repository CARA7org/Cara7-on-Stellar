# Compliance review - ESMA Annex 5

Report date: 2026-08-06. Data sources: `get_pool` (full pool), `get_vehicle` (spot check on VIN UU1K5200XPD709864), `get_reporting` (consolidated snapshot). Pool: `BSF5-DEMO-POOL`, "Bavarian Sky French Auto Leases 5", `cutOffDate` 2026-08-01, 20 exposures, `currencyLabel` "EUR (demo EURC on Stellar testnet)". All pool amounts below are in EUR units as reported by the pool tool (not base units).

## Overall assessment

The demo data model is a credible, internally consistent subset of the ESMA Annex 5 automobile underlying-exposure template (AUTL). Every one of the 20 exposures carries the same four fully populated blocks (`vehicle`, `battery`, `loan`, `obligor`) with no missing values and no null placeholders: field-level completeness within the demo's own schema is 100%. Enumerations are template-flavoured (`accountStatus` values `PERF` / `RSTR`, `legalType` `INDV` / `SMEX`, `energy` `EL`) and performance data cross-foots: `performingPercentage` 95 matches 19 of 20 performing exposures, and `totalArrears` 1,030 EUR equals the two nonzero `arrearsAmount` values (430 + 600 EUR).

Distance from ESMA-submittable: moderate. The demo covers roughly the identification, obligor-descriptor, loan-term, collateral and current-performance cores of Annex 5, but omits entire field families a real EDW submission requires - interest-rate structure fields, payment frequency, valuation dates and methods, balloon / down-payment terms for the `PCP` and `LEASE` products, default and recovery history, and the ESMA "No Data" (ND1-ND5) convention. The obligor block is properly anonymized; no direct personal identifiers were found in any tool output.

## Field-group coverage table

| Field group (Annex 5 analogue) | Demo fields (as named in the data) | Populated | Notes |
|---|---|---|---|
| Exposure / obligor identifiers | `vin`, `loan.contractId`, `obligor.obligorId` | 20/20 | Stable, unique per exposure; not in the ESMA unique-identifier convention (no reporting-entity prefix, no original/new identifier pairs) |
| Obligor descriptors | `legalType`, `country`, `region`, `employmentStatus`, `creditScoreBand` | 20/20 | `region` values such as `FR-IDF`, `FR-ARA` are ISO 3166-2 style, coarser than the NUTS3 geographic region the template asks for; no income or income-verification fields, no credit-impaired flag |
| Loan terms | `contractId`, `productType`, `originationDate`, `maturityDate`, `originalTermMonths`, `remainingTermMonths`, `originalPrincipal`, `currentPrincipal`, `interestRateBps`, `monthlyPayment` | 20/20 | Single flat rate (`interestRateBps`); no rate type / index / margin / floor, no payment frequency, no amortisation type, no per-exposure currency field |
| Collateral / vehicle descriptors | `manufacturer`, `model`, `energy`, `yearOfRegistration`, `mileageOdometer` | 20/20 | No new/used flag, no registration country |
| Valuations | `originalValuation`, `currentValuation`, `residualValue`, `originalLtv` | 20/20 | No valuation dates and no valuation method / source fields; `residualValue` covers the securitised-residual-value concept for the lease and PCP products |
| Performance | `accountStatus`, `daysPastDue`, `arrearsAmount` | 20/20 | Current status only; no default, loss, recovery, redemption or prepayment history |
| Battery (beyond Annex 5) | `serialNumber`, `manufacturer`, `chemistry`, `capacityKwh`, `sohPercent`, `chargeCycles` | 20/20 | Not an AUTL group; supports EV-specific and EU battery-passport style disclosure, batteries keyed by their own serial rather than the vehicle VIN |

Peer-consistency findings (step 2):

- No exposure is missing a value its peers have; the schema is uniform across all 20 records.
- `BSF5-2023-0007` (VIN `UU1K5200XPD709864`): `maturityDate` 2026-07-18 precedes the pool `cutOffDate` 2026-08-01 while `currentPrincipal` is still 4,300 EUR, with `accountStatus` `RSTR`, `daysPastDue` 34, `arrearsAmount` 600 EUR. Coherent for a restructured contract past original maturity, but the template's restructuring fields (arrangement date, revised schedule) would be needed to explain it.
- `BSF5-2023-0006`: `accountStatus` `PERF` with `daysPastDue` 12 and `arrearsAmount` 430 EUR. Plausible (under-30-DPD arrears kept as performing), but the classification convention should be stated explicitly in a real submission.
- Placeholder-looking values: VIN serials contain zero-padding runs (`VF1SC000XRD330906`, `VF1TW0000ND812675`, `UU1K5200XPD709864`), which matches the pool's own note that serials are fictional; valuations and principals are rounded to the hundred, and the three Tesla `originalValuation` figures (43,990 / 52,990 / 42,990 EUR) read as list prices. Populated and consistent, but visibly synthetic.

## Gaps for a real submission

Fields a real EDW / securitisation-repository submission under Annex 5 would need that the demo omits entirely:

1. **Interest-rate structure**: rate type (fixed vs floating), index name, margin, revision frequency, caps and floors. The demo has only `interestRateBps`; the deal-level EURIBOR mechanics live in the note terms, not per exposure.
2. **Payment mechanics**: payment frequency (monthly is implied by `monthlyPayment` but never stated), payment method, amortisation type.
3. **Product-specific cash flows**: down-payment amount, balloon amount and option-to-buy price - material given 11 `LEASE` and 2 `PCP` contracts in the pool.
4. **Valuation metadata**: original and current valuation dates, valuation method / source; `originalLtv` cannot be independently verified without them.
5. **Default and recovery history**: default date and amount, allocated losses, cumulative recoveries, recovery source, litigation flag, redemption date. The demo has no defaulted exposure and no history fields at all.
6. **Prepayment data**: prepayment penalties and cumulative prepayments.
7. **Obligor financials**: primary income, income currency, income-verification method, employment-verification detail, credit-impaired status.
8. **ESMA conventions**: reporting-entity-prefixed unique identifiers, NUTS3 geographic codes (the demo's `region` is coarser), per-exposure currency denomination, and the mandatory ND1-ND5 "No Data" option codes - the demo simply has no mechanism for declaring a field unavailable.
9. **Enumeration mapping**: values like `EMPL`, `SELF`, `UNEM`, `RETI`, `SMEX`, `LEASE`, `PCP` are template-flavoured but would need formal mapping to the Annex 5 controlled code lists before XML submission.

## Privacy check

Confirmed from the full pool dump, the single-vehicle endpoint and the reporting snapshot: **no direct personal identifiers leak**.

- Obligors appear only as pseudonymous tokens (`obligorId` values like `OBL-7F2K1`), with categorical bands: `creditScoreBand` A-D, `employmentStatus` codes, `legalType`, and geography no finer than region (`country` `FR` + `region` such as `FR-BRE`). No names, dates of birth, addresses, national identifiers, contact details or exact incomes anywhere in the data.
- VINs and battery serial numbers are stated by the pool itself to be fictional (real WMI format, invented serials), so the one field class that could act as an indirect identifier in production is synthetic here. In a real submission, VINs are potentially indirect personal data and their handling should follow the anonymization posture already used for obligors.
- `debtorCount` equals `contractCount` (20), so no obligor concentration links records together.
- The reporting snapshot (`get_reporting`) exposes only aggregates, contract addresses and tranche data - nothing obligor-level.
- Residual demo-scale caveat: on a 20-loan pool, the combination `region` + `employmentStatus` + `creditScoreBand` could narrow to an individual if the data were real; at production scale (20,000 vehicles) this quasi-identifier risk shrinks, but it is worth a re-identification review before publishing real data.

## Caveats (demo scope)

- 20 exposures stand in for the 20,000-vehicle target pool; completeness conclusions are about the data model, not statistical representativeness.
- Amounts are demo EURC on Stellar testnet, presented by the pool tool in EUR units; a real submission reports EUR per exposure with an explicit currency field.
- This review covers Annex 5 underlying-exposure disclosure only. Investor-report (Annex 12), inside-information and significant-event templates, and STS notification checks are out of scope, as is any legal opinion on SECR Article 7 compliance.
- Field mapping was done by name and semantics against the AUTL template structure; no formal XML schema validation was run (none exists in the demo).
- The battery block exceeds the current ESMA template; it is a forward-looking disclosure asset for EV collateral, not an Annex 5 requirement.
