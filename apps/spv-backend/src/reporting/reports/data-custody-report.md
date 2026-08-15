# Data custody attestation

**Deal:** BSF5-DEMO-POOL (Bavarian Sky French Auto Leases 5, demo) - **Scope:** availability and integrity of the tokenized data layer - **Date:** 2026-08-06
**Sources:** `get_nft_registry`, `get_ipfs` (store listing + 7 object retrievals), `get_pool`. All amounts below are EUR nominal loan-level figures as recorded in the pool data, not base units.

## Attestation

**AVAILABLE - no gaps found.** Every on-chain token URI (61 of 61) resolves to a retrievable metadata object in the content store, and every sampled object is internally consistent with the registry and the asset pool. The Pool token's `dataReferences` map covers all 20 VINs and all 60 child CIDs match the registry exactly. The waterfall contract address is present in the Pool token metadata. Two minor, non-blocking observations are listed under Gaps & remediation.

## Inventory

Registry minted at 2026-08-01T01:21:38.536Z on Test SDF Network; 4 contracts, 61 tokens.

| Token type | Contract | Tokens in registry | Expected | Status |
|---|---|---|---|---|
| Auto | `CBMXM3FF...YQ4F24W` | 20 (tokenId 0-19) | 20 | OK |
| Battery | `CAVZYMDU...4UM2R` | 20 (tokenId 0-19) | 20 | OK |
| Obligor | `CDFIZNYM...CXGJFU` | 20 (tokenId 0-19) | 20 | OK |
| Pool | `CCTXVNGH...ADGXT7` | 1 (tokenId 0) | 1 | OK |

Every token row carries a `tokenUri` of the form `ipfs://<cid>`, a VIN (null only on the Pool token, as expected) and a mint txHash.

## CID availability

- Registry references **61 distinct CIDs** (60 asset tokens + 1 pool token).
- The IPFS store listing returns **61 CIDs**.
- Cross-check: the two sets match one-to-one. **61/61 registry CIDs present in the store; 0 missing; 0 orphan CIDs** in the store that are not referenced by the registry.
- All 7 sample retrievals below returned valid JSON on the first request; no failed fetches.

## Sample verification

7 metadata objects retrieved across the 4 token types. For each, the embedded VIN was compared to the registry row for that CID, and every attribute value was compared to the pool record.

| # | Type / tokenId | VIN | Checks | Result |
|---|---|---|---|---|
| 1 | Auto 0 | VF1AG0005PD104217 | VIN matches registry; Renault Megane E-Tech EV60, 2023, 21,400 km, valuations 38,900 / 26,400 / 17,500 EUR, LTV 0.86 - all equal to pool | PASS |
| 2 | Auto 19 | 5YJ3E7EA0RF047268 | VIN matches; Tesla Model 3 Highland RWD, 2024, 11,800 km, 42,990 / 34,500 / 23,800 EUR, LTV 0.89 - all equal to pool | PASS |
| 3 | Battery 6 | UU1K5200XPD709864 | VIN matches; serial BYD-SPR-23-90514, BYD, LFP, 27.4 kWh, SoH 95.6%, 260 cycles - all equal to pool battery block | PASS |
| 4 | Battery 17 | VF1TW0000ND812675 | VIN matches; serial LGES-TWI-22-19547, LG Energy Solution, NMC, 22 kWh, SoH 91.2%, 610 cycles - all equal to pool | PASS |
| 5 | Obligor 9 | 5YJ3E7EB0PF035712 | VIN matches; OBL-7Q9L5, INDV, FR / FR-ARA, EMPL, band A, contract BSF5-2023-0010, principal 12,700 EUR, 449 bps, PERF, 0 DPD - all equal to pool | PASS |
| 6 | Obligor 15 | KNAC281GXPS698442 | VIN matches; OBL-8B2V6, SMEX, FR-OCC, SELF, band B, contract BSF5-2023-0016, principal 17,900 EUR, 559 bps, PERF, 0 DPD - all equal to pool | PASS |
| 7 | Pool 0 | n/a | See below | PASS |

**Attribute naming.** Attribute names follow the ESMA/AUTL loan-level taxonomy as expected: Original LTV, Mileage Odometer, Updated Residual Value, Energy (EL), Legal Type (INDV/SMEX), Employment Status (EMPL/SELF), Account Status (PERF), Days Past Due, Interest Rate (bps). Obligor metadata is anonymised (obligor ID only, no PII), consistent with its stated GDPR-safe design.

**Pool token metadata** (`bafkreiddg5...kpxmq`):

- `poolId` BSF5-DEMO-POOL and cut-off 2026-08-01 match the pool record.
- `aggregates` are identical to `get_pool` aggregates: 20 vehicles / 20 contracts / 20 debtors, total financed 721,000 EUR, current principal 275,500 EUR, WAM 21.5 months, WAR 5.52%, performing 95%, arrears 1,030 EUR, monthly collections 10,630 EUR, average battery SoH 95.1%.
- `dataReferences`: contains all 20 pool VINs, each with an auto, battery and obligor CID. All 60 child CIDs were compared entry-by-entry against the registry: **60/60 match** the CID minted for that VIN on the corresponding contract.
- `contracts`: the three child token contract addresses equal the registry's contract IDs, and the **waterfall address is present** (`CAF6GN5WNL5CFKF36K4CHFQQ6B5UCOUV25SIKCK662FRCDAWO2LAU3UR`).

## Gaps & remediation

No availability or integrity gaps. Two minor observations, neither affecting custody:

1. **Legacy "TrueABS" branding in descriptions.** All sampled metadata descriptions read "TrueABS Auto/Battery/Obligor/Pool Token" while the deal now operates under CARA7 branding. Cosmetic only, but since IPFS content is immutable, correcting it would produce new CIDs and require updating the on-chain token URIs. Recommend fixing at the next re-mint rather than as a standalone operation.
2. **Pool token contracts block omits the pool contract itself.** The `contracts` map lists the three child token contracts and the waterfall but not the pool NFT contract. Self-reference is not required for custody, but adding it would make the metadata self-describing. Optional.

**Conclusion:** the tokenized data layer is fully available and consistent - 61/61 token URIs backed by retrievable content, sampled metadata faithful to the registry and the pool, and the Pool token correctly anchors the child documents and the live waterfall contract.
