# Audit report

**Deal:** BSF5-DEMO-POOL - Bavarian Sky French Auto Leases 5 (demo, Stellar testnet) · **Cut-off:** 2026-08-01 · **Audit date:** 2026-08-03 · **Prepared by:** Audit Agent (independent examiner, read-only access)

## Opinion

**Qualified - clean on the numbers, with one cross-layer discrepancy and two scope limitations.** The waterfall v3 cascade reconciles **exactly, to the base unit**, against my independent recomputation (fees → per-class interest → reserve → sequential principal → residual), the token layer is complete (61/61 tokens, every VIN covered three ways), and all three sampled VINs match their IPFS metadata field by field. The qualification rests on: (1) the pool token's immutable IPFS metadata references a waterfall contract address that is **not** the live v3 contract (Finding 1); (2) the vault event index returned no data for any tranche, so vault TVLs could not be reconciled to deposits plus distributions (Finding 5); and (3) the EURIBOR fixing's freshness is verified but its equality with the published EMMI value cannot be confirmed from inside the data room (Finding 6). None of these affects the correctness of the cash flows observed on-chain.

## Scope

- **Layer 1 - Pool → Tokens:** full VIN-by-VIN completeness check of the NFT registry (`get_pool`, `get_nft_registry`); field-by-field IPFS metadata verification for 3 sampled VINs across all three token types (9 documents).
- **Layer 2 - Tokens → IPFS:** resolution of all 10 sampled CIDs plus the pool token CID (`get_ipfs`); coverage check of the pool token's `dataReferences` against the 20 pool VINs and the registry's CIDs.
- **Layer 3 - Pool → Waterfall v3:** reconciliation of the latest on-chain distribution (`get_distributions`) against pool collections (`get_pool`, `get_period_preview`); independent recomputation of the full cascade and reconciliation with on-chain state (`get_waterfall_state`); tranche registry cross-check (`get_tranches`, `get_reporting`); vault flow check attempted via `get_vault_events`.
- All figures below come from tool results; computed figures show their inputs. Amounts are stated in EURC or base units (1 EURC = 10,000,000 base units).

## Findings

**1. DISCREPANCY - Pool token metadata points at a non-live waterfall contract.** The pool token's IPFS metadata (CID `bafkreiddg5...kpxmq`) lists `contracts.waterfall = CAF6GN5WNL5CFKF36K4CHFQQ6B5UCOUV25SIKCK662FRCDAWO2LAU3UR`, while both `get_waterfall_state` and `get_reporting` identify the live waterfall as `CBTBSGD3FETCN74NOWI7HUWQ6IM3SPORMSTMJASQYTPMWHIQP3USSBJU`. The metadata's auto/battery/obligor contract addresses all match the registry, so this is specifically a stale (presumably pre-v3) waterfall reference frozen into content-addressed metadata. Anyone resolving the deal from the pool token alone would audit the wrong contract.

**2. NO EXCEPTION - Token layer is complete.** The registry holds exactly 61 tokens on 4 contracts: 20 auto, 20 battery, 20 obligor (token IDs 0–19 each), covering each of the 20 pool VINs exactly once per type, plus 1 pool token (`tokenCount: 61` confirmed by `get_reporting`). No duplicates, no orphans, no missing VINs. The pool token's `dataReferences` contains all 20 VINs, and all 20 auto CIDs (plus every sampled battery/obligor CID) are identical to the registry's CIDs.

**3. NO EXCEPTION - Distribution total equals clean pool collections, delinquents correctly excluded.** The single recorded distribution (ledger 3,945,870, 2026-08-03T09:26:28Z) totals 99,000,000,000 base units = **9,900.0000000 EURC**. Pool-side: total monthly due 10,630 EURC minus the two excluded installments - BSF5-2023-0006 (430 EURC, 12 days past due) and BSF5-2023-0007 (300 EURC, RSTR, 34 days past due) - is 10,630 − 730 = **9,900 EURC**. Exact match. Pool aggregate `totalArrears` 1,030 EURC = 430 + 600 arrears also reconciles. The delinquent loans are *handled* correctly: excluded from collections and absorbed by the cascade without touching the reserve (see Finding 4).

**4. NO EXCEPTION - The v3 cascade recomputes exactly, to the base unit.** Inputs: collections 9,900 EURC; 3-day period, actual/360; oracle fixing 2.209%. Class A rate = 2.209% + 0.60% = **2.809%** (above the 0% floor, so the floor is not binding).

| Step | My recomputation (inputs shown) | On-chain | Match |
|---|---|---|---|
| Interest A | 100,000 × 2.809% × 3/360 = 23.4083333 EURC | in A's payment (below) | ✓ |
| Interest B | 70,000 × 1.00% × 3/360 = 5.8333333 EURC | payment 58,333,333 base | ✓ exact |
| Interest C | 45,000 × 1.50% × 3/360 = 5.6250000 EURC | payment 56,250,000 base | ✓ exact |
| Reserve | at 5,000 EURC = required 5,000 → top-up 0 | reserve 5,000 EURC | ✓ |
| Principal A | 9,900 − 50 fees − 34.8666666 interest = 9,815.1333334 EURC, all sequential to A | A payment 98,385,416,667 base = 9,838.5416667 EURC = 23.4083333 + 9,815.1333334 | ✓ exact |
| Note factors | A: (100,000 − 9,815.1333334)/100,000 = 90.1848666666% ; B, C: 100% | 90.184 / 100 / 100; outstanding 90,184.8666666 EURC | ✓ (A displayed truncated) |
| Residual | 0 (all cash consumed by A principal) | residual "0" | ✓ |
| Shortfalls / enforcement | none expected | [0, 0, 0], enforced: false | ✓ |
| Next interest | A: 90,184.8666666 × 2.809% × 3/360 = 21.1107742; B: 5.8333333; C: 5.625 EURC | [21.1107742, 5.8333333, 5.625] | ✓ exact |

Caveat inside this finding: the **50 EURC fixed fee is derived** (9,900 − 9,850 paid to tranches − 0 residual − 0 reserve delta), since no tool exposes the contractual fee schedule. The derivation is internally consistent but the fee parameter itself is unaudited.

**5. LIMITATION - Vault event index is empty; TVLs unreconciled.** `get_vault_events` returned `[]` for all three vaults (IDs 1, 2, 3). Vault TVLs are Class A 1,121,764,966,356 base = 112,176.4966356 EURC, Class B 730,089,644,357 base = 73,008.9644357 EURC, Class C 506,655,306,943 base = 50,665.5306943 EURC - each above its outstanding nominal (90,184.8666666 / 70,000 / 45,000 EURC). Exceeding nominal is expected under NAV accrual (deposits plus accrued distributions), but without event data I cannot verify that the distribution's per-vault payments actually landed as inflows, nor explain the deltas. Stated as missing data, not an error.

**6. LIMITATION - EURIBOR fixing fresh, but EMMI value unverifiable in-scope.** The on-chain fixing is 2.209% with age 1,562 seconds (~26 minutes) at query time - comfortably fresh against the 3-day Interest Determination cadence. The data-room tools provide no external EMMI source, so equality with the published fixing could not be independently confirmed. The fixing is at least *used* consistently: 2.209% + 0.60% reproduces both the distribution's Class A interest and the on-chain next-interest figures (Finding 4), and matches the tranching-api Class A `couponBps` 281 (2.809% rounded).

**7. OBSERVATION - Status-label inconsistency on BSF5-2023-0006.** The loan carries `accountStatus: PERF` with `daysPastDue: 12` and 430 EURC arrears. The collection logic correctly keys on arrears (its installment was excluded), and sub-30-day delinquency retaining PERF is defensible under AUTL conventions, but the pool aggregate `performingPercentage: 95` counts it as performing while the servicer treats it as non-paying - two definitions of "performing" coexist.

**8. OBSERVATION - BSF5-2023-0007 is past maturity with outstanding balance.** Maturity 2026-07-18 precedes the 2026-08-01 cut-off, `remainingTermMonths: 0`, yet `currentPrincipal` is 4,300 EURC. Consistent with its RSTR (restructured) status, but the AUTL schedule fields were not updated to reflect the restructured terms.

**9. OBSERVATION - Tranche registry `floorBps` does not represent the prospectus floor.** `get_tranches` shows `floorBps` 6000 / 3000 / 0 for A / B / C. The prospectus 0% floor applies to the Class A fixing; these values do not correspond to it and appear to be vault-level parameters whose meaning is not documented in the data room. Potentially misleading field naming for an investor reading the registry.

## Sample details

Three VINs sampled (3/20 = 15%), chosen to include both delinquent profiles and one clean 2024 origination. All 9 token metadata documents resolved from the IPFS store and matched the pool entry **field by field** - no exceptions:

| VIN | Tokens (auto/battery/obligor IDs) | Fields verified vs pool | Result |
|---|---|---|---|
| VF1AG0005PD104217 (Renault Megane E-Tech EV60, PERF) | 0 / 0 / 0 | VIN, make/model, energy, year 2023, odometer 21,400 km, valuations 38,900 / 26,400 / 17,500 EUR, LTV 0.86; battery serial AESC-EV60-23-88121, NMC, 60 kWh, SoH 94.1%, 310 cycles; obligor OBL-7F2K1, INDV/FR-IDF/EMPL/A, contract BSF5-2023-0001, principal 21,800 EUR, 549 bps, PERF, 0 dpd | ✓ all match |
| UU1K5200XPD709864 (Dacia Spring Extreme 65, **RSTR delinquent**) | 6 / 6 / 6 | VIN, make/model, year 2023, odometer 18,200 km, valuations 22,300 / 12,100 / 7,600 EUR, LTV 0.77; battery BYD-SPR-23-90514, LFP, 27.4 kWh, SoH 95.6%, 260 cycles; obligor OBL-8V2G6, INDV/FR-BRE/UNEM/D, contract BSF5-2023-0007, principal 4,300 EUR, 399 bps, **RSTR, 34 dpd faithfully carried into the token metadata** | ✓ all match |
| KMHK381GXRU580139 (Hyundai Ioniq 5 77, PERF 2024) | 14 / 14 / 14 | VIN, make/model, year 2024, odometer 17,600 km, valuations 52,400 / 38,900 / 26,300 EUR, LTV 0.86; battery SKO-IO5-24-25918, SK On, NMC, 77.4 kWh, SoH 97.4%, 160 cycles; obligor OBL-1Z5T9, INDV/FR-IDF/EMPL/A, contract BSF5-2024-0015, principal 14,100 EUR, 589 bps, PERF, 0 dpd | ✓ all match |

All three VINs' CID triplets in the pool token's `dataReferences` are byte-identical to the registry's CIDs.

## Recommendations

1. **Re-mint or version the pool token** so its `contracts.waterfall` points at the live v3 contract `CBTBSG...SBJU` (Finding 1); if re-minting is undesirable, publish an on-chain or documented mapping from the metadata's address to the current contract.
2. **Fix or backfill the vault event indexer** so distributions can be traced into vault inflows and TVLs reconciled to deposits + payments (Finding 5).
3. **Expose the fee schedule** (the implied 50 EURC/period senior fee) through a data-room tool so it can be audited rather than derived (Finding 4).
4. **Add the EMMI reference value** (or the relay's fetched source value and timestamp) to the oracle state so auditors can confirm the fixing, not just its age (Finding 6).
5. **Align the two "performing" definitions** - either base `performingPercentage` on paying status or document that it is status-based while collections are arrears-based (Finding 7); update AUTL schedule fields on restructure (Finding 8); rename or document `floorBps` in the tranche registry (Finding 9).
