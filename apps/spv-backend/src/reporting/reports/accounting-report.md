# Accounting - period ledger

## Summary

- Deal: BSF5-DEMO-POOL (Bavarian Sky French Auto Leases 5), demo EURC (7 decimals) on Stellar testnet.
- Latest on-chain distribution: period 3, 2026-08-03T19:15:33Z, ledger 3952923. The current servicer preview is for period 4 (due 2026-08-06T19:15:33Z); the demo pool produces identical collections each period (9,900 EURC), so the reconciliation below holds for both.
- Servicer collected 9,900 EURC of 10,630 EURC due; 730 EURC of installments were missed (2 contracts).
- The period-3 waterfall balances to the base unit: ADA 14,900.0001800 EURC fully allocated across fees, interest, reserve refund, Class A principal and dust carry. No shortfalls, residual to Seller = 0.
- Collected vs distributed gap: +0.0000100 EURC (100 base units) paid out in excess of collections, fully explained by rounding-dust carry released from prior periods (carry-in 1,800 minus carry-out 1,700 base units). Not an error.
- Receivables outstanding (pool arrears): 1,030 EURC.

## Collections

From `get_period_preview` (deal contract CB3S3NWG...ATJ4) and `get_pool`:

| Item | EURC |
|---|---|
| Total due this period (20 contracts) | 10,630 |
| Collected (clean PERF loans, 18 contracts) | 9,900 |
| Missed (2 contracts, see Receivables) | 730 |

Check: 9,900 + 730 = 10,630, ties to the pool aggregate `monthlyCollections` = 10,630 EURC.

## On-chain distribution

Period 3 (most recent), all figures in EURC base units (divide by 10,000,000 for EURC):

Sources:

| Source | Base units | EURC |
|---|---|---|
| Collections | 99,000,000,000 | 9,900.0000000 |
| Cash reserve released (full cycle) | 50,000,000,000 | 5,000.0000000 |
| Rounding-dust carry-in | 1,800 | 0.0001800 |
| Available Distribution Amount | 149,000,001,800 | 14,900.0001800 |

Uses, in priority-of-payments order:

| Rank | Use | Base units | EURC |
|---|---|---|---|
| 1 | Fixed fees | 500,000,000 | 50.0000000 |
| 2 | Class A interest | 188,126,000 | 18.8126000 |
| 3 | Class B interest | 58,333,100 | 5.8333100 |
| 4 | Class C interest | 56,250,000 | 5.6250000 |
| 5 | Reserve re-fund to target | 50,000,000,000 | 5,000.0000000 |
| 6 | Class A principal (sequential; B and C = 0) | 98,197,291,000 | 9,819.7291000 |
| 7 | Residual to Seller | 0 | 0.0000000 |
| - | Rounding-dust carry-out | 1,700 | 0.0001700 |
| | Total uses | 149,000,001,800 | 14,900.0001800 |

Total uses equal the ADA exactly; shortfalls are 0 on all three classes.

Payments booked to the paying agent contract (CAXBYHZV...ARZW) match interest + principal per class:

- Class A (CBHFKNK7...DROK): 98,385,417,000 = 188,126,000 + 98,197,291,000 (9,838.5417000 EURC)
- Class B (CDRPAMGB...BU3O): 58,333,100 (5.8333100 EURC)
- Class C (CB3IK7HZ...IOQJ): 56,250,000 (5.6250000 EURC)

Per-note amounts are exact this period (A: 188,126 interest + 98,197,291 principal per note x 1,000 notes; B: 83,333 x 700; C: 125,000 x 450), so no new dust was generated at the class level beyond the carry shown.

Cross-check against the note registry (`get_tranches`): Class A cumulative interest 633,316,000 = 234,083,000 + 211,107,000 + 188,126,000 (periods 1-3) and cumulative principal 294,522,933,000 = 98,151,333,000 + 98,174,309,000 + 98,197,291,000; outstanding 705,477,067,000 = original face 1,000,000,000,000 minus cumulative principal, note factor 70.5477%. Class B cumulative interest 174,999,300 = 3 x 58,333,100; Class C 168,750,000 = 3 x 56,250,000. All tie out. Class A interest declines each period as expected while the class amortizes.

## Reconciliation (collected vs distributed)

| Line | EURC |
|---|---|
| Collected by servicer (period) | 9,900.0000000 |
| Distributed externally: fees | 50.0000000 |
| Distributed externally: to noteholders via paying agent (A+B+C) | 9,850.0000100 |
| Distributed externally: residual to Seller | 0.0000000 |
| Total distributed externally | 9,900.0000100 |
| Gap (distributed minus collected) | +0.0000100 |

Explanation of the gap: the reserve is cash-neutral this period (5,000 EURC released at the top, 5,000 EURC re-funded at rank 5). The extra 100 base units (0.0000100 EURC) paid out over collections come from the rounding-dust carry: 1,800 base units entered the ADA from prior periods and only 1,700 carried out, so 100 base units of previously undistributed dust were released to noteholders this period. This is the designed per-note round-down-and-carry mechanic (timing difference), not a cash leak. Note the distribution record's `total` field (99,000,000,000) equals collections; the line-item sum is 99,000,000,100 for the same dust reason.

## Receivables (missed installments)

Booked as receivables outstanding, from `get_period_preview` and per-loan pool data:

| Contract | Vehicle | Status | Days past due | Missed this period (EURC) | Arrears on book (EURC) |
|---|---|---|---|---|---|
| BSF5-2023-0006 | Citroen e-C4 Shine | PERF | 12 | 430 | 430 |
| BSF5-2023-0007 | Dacia Spring Extreme 65 | RSTR | 34 | 300 | 600 |
| Total | | | | 730 | 1,030 |

The Dacia Spring arrears of 600 EURC represent two missed 300 EURC installments (this period's plus one prior), which is why total receivables (1,030 EURC) exceed this period's missed amount (730 EURC). The 1,030 EURC ties to the pool aggregate `totalArrears`. Performing percentage: 95% of contracts.

## Data sources

- `mcp__deal__get_pool` - pool of 20 EV loans, aggregates (monthly collections 10,630 EURC, arrears 1,030 EURC), per-loan status.
- `mcp__deal__get_period_preview` - current-period servicer view: due 10,630 / collected 9,900 / missed 730 EURC.
- `mcp__deal__get_distributions` - waterfall v4 history, periods 1-3; period 3 used as the most recent distribution (ledger 3952923, 2026-08-03T19:15:33Z); next period 4 due 2026-08-06T19:15:33Z.
- `mcp__deal__get_tranches` - live note registry (ledger 4002309, 2026-08-06T15:59:04Z) for cumulative interest/principal and note factors. The registry also lists a second deal (CARA7 Demo Series 2, in FUNDING); it is outside this ledger's scope.
- `mcp__deal__get_reporting` - consolidated snapshot used to confirm deal and paying agent contract addresses.

All on-chain figures are EURC base units unless labelled EURC; conversion is base units / 10,000,000.
