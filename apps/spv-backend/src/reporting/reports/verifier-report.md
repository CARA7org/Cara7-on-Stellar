# Structural verification

Deal: BSF5-DEMO-POOL (Bavarian Sky French Auto Leases 5) - Stellar testnet - run 2026-08-06.

## Invariant checks

**1. Token counts - PASS.** `get_nft_registry` lists 20 auto (tokenId 0-19) + 20 battery (0-19) + 20 obligor (0-19) + 1 pool (tokenId 0) = 61 tokens.

**2. VIN bijection - PASS.** The 20 VINs in `get_pool` (VF1AG0005PD104217 ... 5YJ3E7EA0RF047268) match the 20 auto token VINs exactly (same set, no missing, no extra, no duplicates); the battery and obligor token VIN sets are identical to the pool's as well (each maps tokenId 0-19 to the same 20 VINs).

**3. URI shape - PASS.** All 61 registry entries satisfy `tokenUri === "ipfs://" + cid` with a CIDv1 `bafkrei...` value (e.g. auto #0: cid `bafkreidfaxak5nkd4ajldps5kwwc3naofb7a72qkwfoh7llftzvxxgcdhm`, tokenUri `ipfs://` + same CID; pool #0 likewise); no entry deviates. Corroboration: the pool token metadata's `dataReferences` per-VIN CIDs (via `get_ipfs`) match the registry's cid column (spot-checked VF1AG0005PD104217 auto/battery/obligor - all three equal).

**4. Contracts - PASS (one sub-check not verifiable).**
- Distinct contract ids: PASS - auto `CBMX...F24W`, battery `CAVZ...UM2R`, obligor `CDFI...GJFU`, pool `CCTX...GXT7` are 4 distinct ids.
- Registry admin = mint holder: NOT VERIFIABLE - `get_nft_registry` exposes only `admin` (`GCV6OX6GKQOJJGD3DTF5AIENK3EKR64OPHCNCX5MGZUT2KTDD5QGFFRI`); no available tool returns the mint holder account, so the equality cannot be checked from tool data.
- Tranche registry exposes 3 classes: PASS - `get_tranches` returns exactly 3 tranches for this deal (dealId 1): Class A SENIOR, Class B MEZZANINE, Class C JUNIOR. (The registry also lists 3 tranches of an unrelated dealId 2, "CARA7 Demo Series 2", which is outside this deal's scope.)

## Overall verdict

**PASS** - all verifiable structural invariants hold: 61 tokens with the expected 20/20/20/1 split, a clean pool-to-token VIN bijection across all three asset token types, uniform `ipfs://<CID>` URIs equal to the registry cid column, 4 distinct contracts and 3 note classes. The single exception is the admin-equals-mint-holder sub-check of invariant 4, which is unverifiable with the tools provided (mint holder not exposed) and is flagged rather than guessed.
