# Interest determination - next period

**Deal:** BSF5-DEMO-POOL (Bavarian Sky French Auto Leases 5, dealId 1) - phase AMORTIZING
**Period:** 4 (3 days, actual/360), payment due 2026-08-06T19:15:33Z
**Data pulled:** 2026-08-06 ~15:59Z (ledger 4,002,309), via `get_waterfall_state`, `get_tranches`, `get_period_preview`, `get_distributions`

## Rate fixing

- **EURIBOR 1M fixing (on-chain RateOracle):** 2.209%
- **Age:** 282,834 seconds = ~3 days 6.6 hours (fixed ~2026-08-03T09:25Z)
- **STALENESS FLAG:** the fixing is older than one full 3-day period and predates the period-3 distribution (2026-08-03T19:15:33Z). Periods 3 and 4 therefore run on the same fixing. If the Interest Determination cadence requires a fresh fixing per period, the oracle push (`pnpm oracle:push`) should run before the 2026-08-06T19:15:33Z payment date. The figures below use the current on-chain fixing, as the contract will.

All-in rates per class:

| Class | Pricing | Arithmetic | All-in rate |
|---|---|---|---|
| A (senior) | EURIBOR 1M + 0.60%, floor 0% | max(0, 2.209% + 0.600%) - floor not binding | **2.809%** (280.9 bps) |
| B (mezzanine) | fixed | - | **1.00%** (100 bps) |
| C (junior) | fixed | - | **1.50%** (150 bps) |

## Coupon amounts

Outstanding nominals from the waterfall state (base units from tranching-api converted at 10^7 base units = 1 EURC):

| Class | Outstanding (base units) | Outstanding (EURC) | Note factor | Notes |
|---|---|---|---|---|
| A | 705,477,067,000 | 70,547.7067 | 70.5477% | 1,000 |
| B | 700,000,000,000 | 70,000.0000 | 100% | 700 |
| C | 450,000,000,000 | 45,000.0000 | 100% | 450 |

Prior interest shortfalls carried in: **0 / 0 / 0** (all classes current), so amount due = accrued interest.

Formula: interest = outstanding nominal x bps / 10,000 x 3 / 360.

- **Class A:** 70,547.7067 x 280.9 / 10,000 x 3 / 360 = 1,981.6850810 x 3 / 360 = **16.5140423 EURC**
- **Class B:** 70,000 x 100 / 10,000 x 3 / 360 = 700 x 3 / 360 = **5.8333333 EURC**
- **Class C:** 45,000 x 150 / 10,000 x 3 / 360 = 675 x 3 / 360 = **5.6250000 EURC**

Per-note amounts (class amount / note count, rounded down at 7 decimals; the remainder becomes rounding-dust carry):

| Class | Accrued (base units) | / notes | Per note (EURC) | Aggregate paid (EURC) | Dust to carry (EURC) |
|---|---|---|---|---|---|
| A | 165,140,423 | / 1,000 = 165,140.423, floor 165,140 | 0.0165140 | 16.5140000 | 0.0000423 |
| B | 58,333,333 | / 700 = 83,333.333, floor 83,333 | 0.0083333 | 5.8333100 | 0.0000233 |
| C | 56,250,000 | / 450 = 125,000 exact | 0.0125000 | 5.6250000 | 0 |

Total interest payable to the paying agent contract: 16.514 + 5.83331 + 5.625 = **27.97231 EURC**.

## Coverage analysis

From the period preview and waterfall state (all EURC):

- Expected collections: **9,900** (total due 10,630; missed 730: BSF5-2023-0006, PERF 12 dpd, 430; BSF5-2023-0007, RSTR 34 dpd, 300)
- Cash reserve released at the top of the waterfall (full-cycle): **5,000**
- Rounding-dust carry in: **0.00017** (1,700 base units, = period 3's carry-out)
- **ADA = 9,900 + 5,000 + 0.00017 = 14,900.00017**

Against the senior obligations:

- Fees + all three coupons = 50 + 16.5140423 + 5.8333333 + 5.625 = **77.9723756**
- Coverage (ADA / that) = 14,900.00017 / 77.9723756 = **~191.1x** - fully covered
- Collections alone (excluding the reserve) still cover it ~127.0x (9,900 / 77.9723756)
- Through the reserve re-fund (rank 5): 50 + 27.97231 + 5,000 = 5,077.97231; ADA covers it **2.93x**, leaving ~9,822.03 for sequential principal to Class A (rank 6)

No interest shortfall is expected this period; the two missed installments are absorbed with a wide margin.

## Prior-period comparison

Contract sanity check: the deal contract's `nextInterestEurc` = **[16.5140423, 5.8333333, 5.625]** and tranching-api's `nextPayment.estimatedInterest` = 165,140,423 / 58,333,333 / 56,250,000 base units - both **match my computed figures exactly**.

Interest paid in the last on-chain distribution (period 3, 2026-08-03T19:15:33Z):

| Class | Period 3 paid (base units) | Period 3 (EURC) | Period 4 due (EURC) | Delta |
|---|---|---|---|---|
| A | 188,126,000 | 18.8126 | 16.5140 | -2.2986 (amortization) |
| B | 58,333,100 | 5.83331 | 5.83331 | unchanged |
| C | 56,250,000 | 5.62500 | 5.62500 | unchanged |

The Class A decline is fully explained by sequential principal: outstanding at period 3 was 100,000 - (9,815.1333 + 9,817.4309 repaid in periods 1-2) = 80,367.4358 EURC, and 80,367.4358 x 280.9 / 10,000 x 3 / 360 = 18.8126773, which floors per note to exactly the 188,126,000 base units paid on-chain. The same rate (2.809%) reproduces both periods, consistent with the fixing not having moved. The paying agent shows period 3 fully pushed for all three classes (balance 1e-7 EURC residual).

## Method notes

- Every figure comes from the four MCP tools listed in the header; no external data. Base-unit amounts (10^-7 EURC) were converted by dividing by 10,000,000 and are labelled as such.
- Class A's rate is applied as 280.9 bps (tranching-api `rateUnits` 2809 in 0.001% units, `allInPct` 2.809); the `couponBps: 281` field is a rounded display value and was not used.
- Note counts (1,000 / 700 / 450) follow from the 100 EURC denomination on original faces of 100,000 / 70,000 / 45,000 EURC.
- Rounding convention applied: per-note floor at 7 decimals, aggregate = per-note x note count, remainder carried into next period's ADA (matches the observed carry chain 900 -> 1,800 -> 1,700 base units).
- The 0% floor was evaluated for Class A only and is not binding at the current fixing.
- Tranching-api also returns dealId 2 (CARA7 Demo Series 2, FUNDING phase); it is a separate deal and was excluded.
- Caveat: the EURIBOR fixing is ~3.3 days old (see Rate fixing). If a fresh fixing lands before the payment date, Class A's coupon changes to 70,547.7067 x (new fixing + 60 bps, floored at 0) / 10,000-bps x 3 / 360; Classes B and C are unaffected.
