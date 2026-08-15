# Payment confirmation

**Deal:** BSF5-DEMO-POOL (Bavarian Sky French Auto Leases 5, demo) - Stellar testnet
**Period under review:** Period 2 (latest completed), ledger 3,950,514, 2026-08-03T15:54:20Z
**Deal phase:** AMORTIZING · **Paying agent contract:** `CAXBYHZVHXOP3HQCMXPPVZMDUYEO27CTQQQDMWVNMMGSRCBSJHGIARZW`
All figures in EURC unless stated as base units (1 EURC = 10,000,000 base units).

## Confirmation

**Paid as instructed: YES - qualified.**

- **Leg 1 (waterfall → paying agent contract): CONFIRMED.** The period-2 class aggregates recorded in the distribution history reconcile with the paying agent contract's per-class allocations to within the documented rounding dust (0.00009 EURC, which reappears in the deal's carry pot).
- **Leg 2 (paying agent → noteholders): CONFIRMED FROM AGENT-CONTRACT STATE ONLY.** The paying agent reports every class fully pushed (cursor = holder count, `pushed: true` for all three classes) and holds a **zero** EURC balance, which is only possible if all allocations left the contract. However, the independent noteholder registry returned **no holders for any class**, and every note-events endpoint returned HTTP 404, so the per-holder receipts could not be independently verified. See Exceptions.

I confirm settlement, not entitlement: whether these amounts were correctly computed is the Calculation Agent's report.

## Class-aggregate reconciliation (waterfall → paying agent)

Source: `get_distributions` (latest record, ledger 3,950,514) vs `get_waterfall_state → onchain.payingAgent.allocs` (lastPeriod = 2).

| Class | Distribution record (entitlement) | Agent allocation: interest | Agent allocation: principal | Agent allocation: total | Difference (dust) |
|---|---|---|---|---|---|
| A (senior) | 9,838.5416667 (98,385,416,667 bu) | 21.1107 | 9,817.4309 | 9,838.5416 | 0.0000667 |
| B (mezzanine) | 5.8333333 (58,333,333 bu) | 5.83331 | 0 | 5.83331 | 0.0000233 |
| C (junior) | 5.6250000 (56,250,000 bu) | 5.625 | 0 | 5.625 | 0 |
| **Total** | **9,850.0000000** | 32.56901 | 9,817.4309 | **9,849.99991** | **0.0000900** |

Supporting checks (inputs shown):

- **Top of waterfall:** collections 9,900 (99,000,000,000 bu, matching `collected: 9900` in the waterfall state; 730 EURC of due installments were missed and absorbed by the cascade). Collections 9,900 − class total 9,850 = **50.00 = the fixed senior fees (rank 1)**. Residual to Seller: 0.
- **Reserve (full cycle):** the record does not itemize release/refund, but the on-chain reserve stands at exactly 5,000 after the period - consistent with a 5,000 release at the top and a 5,000 re-fund at rank 5 (net zero).
- **Rounding dust:** allocations are per-note rounded down (A principal 9.8174309 × 1,000 notes; B interest 0.0083333 × 700; C interest 0.0125 × 450). The period dust of 0.0000900 × 2 periods = **0.00018**, matching the on-chain carry `carryEurc: 0.00018` exactly. The dust sits in the deal's carry, not the paying agent.
- **Cumulative cross-check:** principal repaid on Class A is 19,632.5642 total; less this period's 9,817.4309 gives 9,815.1333 for period 1 - consistent with the period-1 record (identical class totals are arithmetically expected: constant collections, Class A takes all remainder after fees and B/C interest).

## Holder fan-out reconciliation (paying agent → noteholders)

Source: `get_waterfall_state → payingAgent` vs `get_noteholders`.

| Class | Push status (agent contract) | Implied payout to holder(s) | Registry says |
|---|---|---|---|
| A | cursor 1 / 1 holders, pushed ✔ | 9,838.5416 to 1 holder (1,000 notes) | **no holders returned** |
| B | cursor 1 / 1 holders, pushed ✔ | 5.83331 to 1 holder (700 notes) | **no holders returned** |
| C | cursor 1 / 1 holders, pushed ✔ | 5.625 to 1 holder (450 notes) | **no holders returned** |

- The paying agent contract's EURC balance is **0**, fully explained by: all three classes pushed, no unpushed allocations, no claimables held, dust held in the deal's carry rather than the agent. There is **no unexplained residual balance**.
- The per-holder delta reconciliation required by this mandate **could not be performed**: the noteholder registry (`get_noteholders`) returned empty holder lists for all three classes, contradicting the agent contract's own `holderCount: 1` per class. I state this as missing data rather than inferring holder identities or amounts.
- No corroborating `holder_paid` / `claimed` events could be cited: `get_note_events` returned HTTP 404 for all six known contract IDs (the three note-token contracts from the registry and the three class contracts from the tranche registry).

## Open claims

**None visible.** The agent contract reports all period-2 allocations pushed (`pushed: true`, cursor = holder count in every class) and a zero balance, so no amounts are held as claimable from failed pushes. This cannot be double-confirmed from the holder side because of the registry gap below.

## Exceptions

1. **Empty noteholder registry (blocking for leg 2).** `get_noteholders` returned `holders: []` for all three classes while the paying agent contract reports 1 holder per class. This looks like an indexer gap, not a settlement failure (the agent's zero balance and pushed flags are on-chain state), but the mandated per-holder reconciliation is impossible until the registry is repopulated.
2. **Note events unavailable.** All `get_note_events` calls failed with HTTP 404 (tranching indexer), so no `holder_paid` / `claimed` events corroborate the pushes around ledger 3,950,514.
3. **Distribution record format.** The history lacks the per-class interest/principal split, ADA, reserve released/refunded and carry fields; the split above was reconstructed from the paying agent's allocation state. Its payment map is also keyed by the tranche registry's class contract IDs (`CDFKE6FD…`, `CAWLZBFR…`, `CCS4WQ7Z…`), which differ from the registry's note-token contracts and do not name the paying agent contract as payee. Under the v4 money flow (nothing is ever paid into note-token contracts) I read these keys as class identifiers, but the presentation should be fixed.
4. **Stale tranche statistics.** The tranche registry still reports vault-era TVL/share-price figures (e.g. Class A "TVL" 100,244.7081902 EURC vs on-chain outstanding 80,367.4358 EURC, note factor 80.36743%). Ignored for settlement; flagged for the reporting pipeline.
