# Waterfall recalculation

## Result

**MATCH - every line of period 3 reproduces exactly, to the base unit (10^-7 EURC).**

The most recent distribution is period 3 (2026-08-03T19:15:33Z, ledger 3952923, phase AMORTIZING). Recomputed independently from the pool and the on-chain state:

- Collections recomputed from the pool: **9,900 EURC** - identical to the period preview and the on-chain record.
- Expected cascade on an ADA of **14,900.00018 EURC**: fees 50, Class A interest 18.8126, Class B interest 5.83331, Class C interest 5.6250, reserve re-fund 5,000, Class A principal 9,819.7291, B/C principal 0, residual 0, dust to carry 0.00017 EURC. All twelve lines match on-chain with **delta = 0**.
- Total handed to the paying agent contract: **9,850.00001 EURC** (98,500,000,100 base units), which equals interest + principal across the three classes and reconciles the ADA to the base unit.
- Post-distribution state matches: note factors 70.5477067% / 100% / 100%, reserve 5,000 EURC, carry 0.00017 EURC, shortfalls 0.

## Collections recomputed

Rule applied: sum the monthly installments of loans with `accountStatus = PERF` and `daysPastDue = 0`; everything else is excluded.

| # | Contract | Status | DPD | Installment (EURC) | Included |
|---|---|---|---|---|---|
| 1 | BSF5-2023-0001 | PERF | 0 | 640 | yes |
| 2 | BSF5-2022-0002 | PERF | 0 | 470 | yes |
| 3 | BSF5-2024-0003 | PERF | 0 | 720 | yes |
| 4 | BSF5-2023-0004 | PERF | 0 | 455 | yes |
| 5 | BSF5-2023-0005 | PERF | 0 | 505 | yes |
| 6 | BSF5-2023-0006 | PERF | 12 | 430 | **no - PERF but 12 days past due** |
| 7 | BSF5-2023-0007 | RSTR | 34 | 300 | **no - restructured, 34 days past due** |
| 8 | BSF5-2023-0008 | PERF | 0 | 560 | yes |
| 9 | BSF5-2024-0009 | PERF | 0 | 610 | yes |
| 10 | BSF5-2023-0010 | PERF | 0 | 480 | yes |
| 11 | BSF5-2024-0011 | PERF | 0 | 690 | yes |
| 12 | BSF5-2023-0012 | PERF | 0 | 745 | yes |
| 13 | BSF5-2024-0013 | PERF | 0 | 580 | yes |
| 14 | BSF5-2023-0014 | PERF | 0 | 445 | yes |
| 15 | BSF5-2024-0015 | PERF | 0 | 565 | yes |
| 16 | BSF5-2023-0016 | PERF | 0 | 640 | yes |
| 17 | BSF5-2024-0017 | PERF | 0 | 420 | yes |
| 18 | BSF5-2022-0018 | PERF | 0 | 340 | yes |
| 19 | BSF5-2024-0019 | PERF | 0 | 495 | yes |
| 20 | BSF5-2024-0020 | PERF | 0 | 540 | yes |

- Sum of the 18 clean-PERF installments: **9,900 EURC**. Excluded: 430 + 300 = 730 EURC.
- Cross-check vs the period preview tool: total due 10,630, collected 9,900, missed = the same two contracts for 430 and 300. **Match.**
- Cross-check vs on-chain period 3: `collections` = 99,000,000,000 base units = 9,900 EURC. **Match.**

## Expected cascade (period 3)

All arithmetic in EURC base units (integer, floor division), 1 EURC = 10,000,000 base units.

**Inputs.** EURIBOR 1M fixing from the on-chain RateOracle: 2.209%; Class A all-in = max(0, 2.209% + 0.60%) = **2.809%** (floor not binding; contract rate units 2809 per 100,000). Class B 1.00% fixed, Class C 1.50% fixed. Day count: 3/360. Note counts: 1,000 / 700 / 450 (denomination 100 EURC). Class A outstanding entering period 3 = original face 1,000,000,000,000 minus principal paid in periods 1 and 2 (98,151,333,000 + 98,174,309,000) = **803,674,358,000 base units** (80,367.4358 EURC); B = 700,000,000,000; C = 450,000,000,000. No shortfalls outstanding.

**ADA build-up** (base units):

| Component | Amount |
|---|---|
| Collections | 99,000,000,000 |
| Cash reserve released in full (full-cycle) | 50,000,000,000 |
| Dust carry in from period 2 (its `carryOut`) | 1,800 |
| **Available Distribution Amount** | **149,000,001,800** |

Matches the on-chain `ada` = 149,000,001,800.

**Ranks.** At each noteholder rank: aggregate = floor of the exact formula, per-note = floor(aggregate / note count), paid = per-note x count, dust = aggregate - paid (leaves the cascade, joins next period's carry).

| Rank | Formula (base units) | Aggregate | Per note (floor) | Paid | Dust | ADA remaining |
|---|---|---|---|---|---|---|
| start | | | | | | 149,000,001,800 |
| 1. Fixed fees | 50 EURC | 500,000,000 | n/a | 500,000,000 | 0 | 148,500,001,800 |
| 2. Class A interest | 803,674,358,000 x 2809/100,000 x 3/360 = 188,126,772.63 → floor | 188,126,772 | 188,126 | 188,126,000 | 772 | 148,311,875,028 |
| 3. Class B interest | 700,000,000,000 x 1% x 3/360 = 58,333,333.33 → floor | 58,333,333 | 83,333 | 58,333,100 | 233 | 148,253,541,695 |
| 4. Class C interest | 450,000,000,000 x 1.5% x 3/360 | 56,250,000 | 125,000 | 56,250,000 | 0 | 148,197,291,695 |
| 5. Reserve re-fund to 5,000 EURC | 50,000,000,000 | 50,000,000,000 | n/a | 50,000,000,000 | 0 | 98,197,291,695 |
| 6. Class A principal (sequential) | min(remaining, outstanding) = 98,197,291,695 | 98,197,291,695 | 98,197,291 | 98,197,291,000 | 695 | 0 |
| 6. Class B / C principal | nothing remains | 0 | 0 | 0 | 0 | 0 |
| 7. Residual to Seller | | 0 | | 0 | 0 | 0 |

- No shortfalls arise (every interest rank paid in full) and none were carried in.
- **Dust carry out = 772 + 233 + 0 + 695 = 1,700 base units** (0.00017 EURC).
- Reconciliation: 500,000,000 + 188,126,772 + 58,333,333 + 56,250,000 + 50,000,000,000 + 98,197,291,695 = 149,000,001,800 = ADA, residual 0. Exact.
- Expected total to the paying agent = paid interest + principal = 188,126,000 + 58,333,100 + 56,250,000 + 98,197,291,000 = **98,500,000,100 base units = 9,850.00001 EURC**.
- Expected post-state: Class A outstanding 803,674,358,000 - 98,197,291,000 = **705,477,067,000** (factor 70.5477067%); B and C factors 100%; reserve back at 5,000 EURC; carry 1,700 base units.

## On-chain actuals (period 3)

From the distributions tool (base units): collections 99,000,000,000; reserveReleased 50,000,000,000; carryIn 1,800; ada 149,000,001,800; fees 500,000,000; Class A interest 188,126,000 / principal 98,197,291,000; Class B interest 58,333,100 / principal 0; Class C interest 56,250,000 / principal 0; reserveRefunded 50,000,000,000; residual 0; carryOut 1,700; shortfalls 0 everywhere. Payments to the paying agent contract: A 98,385,417,000, B 58,333,100, C 56,250,000.

From the waterfall state tool (after period 3): reserve 5,000 EURC; carry 0.00017 EURC; note factors 70.5477% / 100% / 100%; outstanding 70,547.7067 / 70,000 / 45,000 EURC; cumulative principal repaid on A 29,452.2933 EURC; paying agent lastPeriod 3 with all three classes `pushed: true` (A: 18.8126 interest + 9,819.7291 principal, per-note principal 9.8197291 EURC; B: 5.83331; C: 5.625) and a residual agent balance of 0.0000001 EURC. From the tranches tool: Class A outstanding 705,477,067,000, cumulative principal paid 294,522,933,000 = 98,151,333,000 + 98,174,309,000 + 98,197,291,000, consistent with the derived opening balance.

## Delta table (expected vs on-chain, period 3)

| Line | Expected (EURC) | On-chain (EURC) | Delta |
|---|---|---|---|
| Fixed fees | 50.0000000 | 50.0000000 | 0 |
| Senior A interest | 18.8126000 | 18.8126000 | 0 |
| Mezzanine B interest | 5.8333100 | 5.8333100 | 0 |
| Junior C interest | 5.6250000 | 5.6250000 | 0 |
| Reserve re-fund | 5,000.0000000 | 5,000.0000000 | 0 |
| Senior A principal | 9,819.7291000 | 9,819.7291000 | 0 |
| Mezzanine B principal | 0 | 0 | 0 |
| Junior C principal | 0 | 0 | 0 |
| Senior A total (int + prin) | 9,838.5417000 | 9,838.5417000 (payments row) | 0 |
| Mezzanine B total | 5.8333100 | 5.8333100 | 0 |
| Junior C total | 5.6250000 | 5.6250000 | 0 |
| Residual to Seller | 0 | 0 | 0 |
| Dust / carry out | 0.0001700 | 0.0001700 | 0 |
| Shortfalls (A / B / C) | 0 / 0 / 0 | 0 / 0 / 0 | 0 |
| Sum handed to paying agent | 9,850.0000100 | 9,850.0000100 | 0 |

Post-distribution state:

| State | Expected | On-chain | Delta |
|---|---|---|---|
| Class A note factor | 70.5477067% | 70.5477% (rounded display; outstanding 705,477,067,000 base units exact) | 0 |
| Class B / C note factors | 100% / 100% | 100% / 100% | 0 |
| Reserve | 5,000 EURC | 5,000 EURC | 0 |
| Carry | 0.00017 EURC | 0.00017 EURC | 0 |

**Every delta is zero.** The only non-waterfall observation: the paying agent contract retains 1 base unit (0.0000001 EURC) after all pushes completed - per-holder pro-rata rounding inside the agent's push, outside the cascade itself; the per-class allocations it received and pushed match the waterfall output exactly.

## Method

- **Sources.** Pool tool: the 20 loans, statuses, days past due, installments. Period preview tool: cross-check of due/collected/missed. Waterfall state tool: EURIBOR fixing (2.209%), phase, reserve, carry, factors, shortfalls, paying agent state. Distributions tool: the period 3 on-chain record and periods 1-2 (used only to derive the Class A opening balance). Tranches tool: original faces, coupon pricing, outstanding, cumulative paid (deal 1 only; the tool also lists "CARA7 Demo Series 2", still in FUNDING, which is a different deal and was excluded). No number was copied without recomputation except raw on-chain state (rates, balances, history), and no tool call failed.
- **Units.** All cascade arithmetic in EURC base units (1 EURC = 10,000,000 base units), integer with floor division, converted to EURC only for display.
- **Interest.** Outstanding nominal x rate x 3/360, rate in contract units per 100,000 (Class A 2809 = 2.809% = EURIBOR 1M 2.209% + 0.60% spread, 0% floor not binding; B 1,000 = 1.00%; C 1,500 = 1.50%), aggregate floored to an integer base unit.
- **Per-note rounding.** At each noteholder rank: per-note = floor(aggregate / note count) with note counts 1,000 / 700 / 450; paid = per-note x count; the remainder is dust that leaves the cascade and joins next period's carry (it is not a shortfall). Period 3 dust: 772 (A interest) + 233 (B interest) + 0 (C interest) + 695 (A principal) = 1,700 base units, matching `carryOut`.
- **Sequencing.** ADA = collections + full reserve release + prior carry; then fees, A/B/C interest (plus shortfalls, none here), reserve re-fund to 5,000 EURC, sequential principal A then B then C, residual. Class A absorbed all remaining principal cash (98,197,291,695 base units available vs 803,674,358,000 outstanding), so B and C received no principal and the residual was 0.
- **Verification identity.** fees + interest consumed + reserve re-fund + principal consumed + residual + dust = ADA held exactly (149,000,001,800 base units), and the paying agent received precisely interest + principal per class, confirming both interest and principal flow to the paying agent contract and nothing to the note token contracts.
