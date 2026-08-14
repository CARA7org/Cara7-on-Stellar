# Soroban contracts

Five Rust crates. Three of them carry the ABS money flow: subscription escrow
-> closing DvP -> waterfall -> paying agent -> holders. The two others feed the
deal with a rate and hold the asset registry.

| Crate | Role |
|---|---|
| `note-token` | One SEP-41 note token per class (Senior, Mezzanine, Junior) |
| `abs-deal` | Deal lifecycle, subscription escrow, closing DvP, waterfall |
| `paying-agent` | Pushes interest and principal to every holder |
| `rate-oracle` | EURIBOR 1M fixings, SEP-40 style |
| `asset-nft` | NFT registry of the pool (auto, battery, obligor, pool) |

## note-token

The per-class note. It is transferable, it has **0 decimals** (a note is
discrete, `denomination` = 100 EURC of face) and its supply is fixed after
`finalize_issuance`. There is no burn, no deposit and no withdraw.

The contract keeps the holder registry, a lazy day-weight ledger (a transfer in
the middle of a period splits the next coupon pro rata temporis) and the
end-of-period balance snapshots, so principal follows the holder of record. The
`abs-deal` contract is the controller.

## abs-deal

The lifecycle is Funding -> Amortizing -> Enforced -> Matured, plus Aborted.

- Funding: `subscribe` and `cancel` move EURC in and out of the escrow. A
  cancel is the only exit before the closing. The seller funds the
  subordinated loan with `fund_sub_loan`.
- `close()` is one atomic DvP: the subordinated loan becomes the cash reserve,
  the full proceeds go to the seller, the notes are issued at par, and period 1
  opens.
- `distribute(period, collections)` runs the waterfall. The available
  distribution amount is the collections plus the full reserve released plus
  the rounding dust carried over. The ranks are: fees, then interest (Class A
  at EURIBOR 1M + 60 bps floored at zero, Class B at 1.00 %, Class C at 1.50 %,
  actual/360 on the outstanding), then the reserve re-funding, then sequential
  principal A -> B -> C, then the residual to the seller. Rounding is per note
  and always floors in the deal's favour; the remainder joins the carry.
- After `set_enforced`, which is irreversible, each class receives its interest
  then its principal, and the reserve is not re-funded.

Interest AND principal both leave through the paying agent. Nothing is ever
paid into the note tokens.

Invariant: after every `distribute`, the asset balance of the deal equals the
reserve plus the carry.

## paying-agent

The distributor to the investors. Each period `distribute` funds it, then the
permissionless `push_batch(period, class, <= 10)` pushes EURC to the holders:
interest by day weight, principal by holder of record. The batch is resumable
through its cursor and protected against a double payment by its markers.

A push that fails, because the holder has no trustline, parks as a claimable
that the holder takes with `claim`. The contract keeps a cumulative interest
and principal counter per holder. Sub-stroop dust folds into the next interest
pot of the class.

## rate-oracle

The EURIBOR 1M oracle, with a `lastprice`/`prices` interface in the Reflector
and SEP-40 style. Rates are signed values in 0.001 % units. A write checks the
staleness and the deviation. The relay of `apps/spv-backend` feeds it with
`pnpm oracle:push`.

## asset-nft

An NFT registry built on OpenZeppelin: 61 tokens for the autos, the batteries,
the obligors and the pool, each with a `token_uri` that points at IPFS. No
money flows through it.

## Scales

- EURC has 7 decimals.
- Rates are in 0.001 % units: `RATE_SCALE = 100_000`.
- Note factors are in `FACTOR_SCALE = 10_000_000` units, which is 100 %.
- A balance is a number of notes, an integer. Money is in stroops. The factor
  is derived, never stored.

## Deployed on testnet

Reference deal:

| Contract | Id |
|---|---|
| abs-deal | `CB3S3NWG7IUKUBAWAAJPFKVMCIMTRJ73GHZX6YZASRMZPVUGYFLCATJ4` |
| paying-agent | `CAXBYHZVHXOP3HQCMXPPVZMDUYEO27CTQQQDMWVNMMGSRCBSJHGIARZW` |
| CARA7A - Class A, 1,000 notes | `CBHFKNK7UK6YBVXZUWPOMY6LK44FZJSKWHPF4HJBUBV64KC455IJDROK` |
| CARA7B - Class B, 700 notes | `CDRPAMGBJ6BSRQZE5M56DYCFZW7ODPFVCYLT4AA2OQGIUIDHPCTRBU3O` |
| CARA7C - Class C, 450 notes | `CB3IK7HZQMZZG4GIYOEUPRUEIDUP54MIHXIBYLLAM4QUKHB7H7MYIOQJ` |
| rate-oracle | `CAAOMPQADAW34FU4VUXDUHS6RDF6SVGCTK4S2T2YONIKNQA22IBYA72X` |

Series 2 is a second generation of the same three crates, left in the Funding
phase on purpose so that the subscribe, cancel and closing flow stays
demonstrable. It is one tenth of the reference deal: Class A 100 notes, Class B
70, Class C 45, a reserve of 500 and fees of 5 per period.

| Contract | Id |
|---|---|
| abs-deal | `CBVCKQH6CSGRS5W7SYZAJJ3MH5QUWNX7HKWTSLXK4YHPOSY3YZJ2I7AP` |
| paying-agent | `CCD2G6GCWW77RKX3Y4JXUOSNPD7NUAH5Y46SLV64AVACUYR5HZT7E7N4` |
| CARA7A2 | `CAXW4LVJEJL4A4S7WH5VZOMITJDUXFXIPYDRX7MJF64HLYO6X3JMNZEP` |
| CARA7B2 | `CAXTFDN7ATWS4MJALVOLOWWQAAEOAIWGGKQ2N3XSQKEGKKDE6B7V7E6S` |
| CARA7C2 | `CCCFVGMXJE2ZM22CP56BPQBO56I5PN5X4IB6Y2RFK2X2E2FNYLL4NEAF` |

The demo EURC is a self-issued SAC:
`CBEO2RDQKBM7S3TYOYKBWAJEC6WMYPCW6JJWX47UCLFMUJI2EUZPJOXW`.

A contract is immutable, so one change of terms means one new deal instance.
The previous history stays on-chain under the old ids.

## Interface used by the fronts

`subscribe(investor, class, notes)` and `cancel(investor, class, notes)` on the
deal, the SEP-41 `transfer` on a note token, and `claim(holder)` on the paying
agent. There is no deposit, no withdraw and no redeem. An error surfaces as
`Error(Contract, #N)`.

## Build and test

```sh
cargo test --workspace     # 62 tests
stellar contract build     # wasm build, stellar-cli >= 25.2
```

Build the wasm with the Stellar CLI, not with raw cargo. `target/` is ignored
by git.
