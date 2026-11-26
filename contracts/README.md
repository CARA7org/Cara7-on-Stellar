# Soroban contracts

Five Rust crates. Three of them carry the ABS money flow: subscription escrow
-> closing DvP -> waterfall -> paying agent -> holders. The two others feed the
deal with a rate and hold the asset registry.

| Crate | Role |
|---|---|
| `note-token` | One SEP-41 note token per class (Senior, Mezzanine, Junior) |
| `abs-deal` | Deal lifecycle, subscription escrow, closing DvP, configurable waterfall |
| `paying-agent` | Pushes interest and principal to every holder |
| `rate-oracle` | EURIBOR 1M fixings, SEP-40 style |
| `asset-nft` | NFT registry of the pool (auto, battery, obligor, pool) |

## note-token

The per-class note. It is transferable, it has **0 decimals** (a note is
discrete, `denomination` is the face of one note, for example 100 EURC in the
reference deal) and its supply is fixed after `finalize_issuance`. There is no
burn, no deposit and no withdraw.

The contract keeps the holder registry, a lazy day-weight ledger (a transfer in
the middle of a period splits the next coupon pro rata temporis) and the
end-of-period balance snapshots, so principal follows the holder of record. The
`abs-deal` contract is the controller. `controller()` returns it, and a
transfer asks it `is_eligible(to)` (error 9, `NotEligible`).

## abs-deal

The lifecycle is Funding -> Amortizing -> Enforced -> Matured, plus Aborted.

- Funding: `subscribe` and `cancel` move EURC in and out of the escrow. A
  cancel is the only exit before the closing. The seller funds the
  subordinated loan with `fund_sub_loan`.
- `close()` is one atomic DvP: the subordinated loan becomes the cash reserve,
  the full proceeds go to the seller, the notes are issued at par, and period 1
  opens.
- `distribute(period, collections)` runs the priority of payments of the
  deal: an ordered rank list in its configuration. The reference order is
  fees, the interest of each class, the reserve re-funding, sequential
  principal, then the residual to the seller. Other deals can use pro rata
  principal, trigger conditions, several fee lines and an on-need reserve.
  [WATERFALL.md](../WATERFALL.md) gives the rules. Rounding is per note and
  always floors in the deal's favour. The remainder joins the carry.
- After `set_enforced`, which is irreversible, the deal runs its `enforced`
  order. The reserve is released in full and is not re-funded. The reference
  order pays each class its interest, then its principal.

Interest AND principal both leave through the paying agent. Nothing is ever
paid into the note tokens.

The configuration of a deal sets its shape. One binary serves all deals:

- 1 to 8 classes (`MAX_CLASSES`). Each class has a fixed rate or a floating
  rate: a spread over EURIBOR 1M, with an optional floor of the index and an
  optional floor of the all-in rate.
- One note denomination for all classes, and one rounding unit (for example
  0.01, a cent per note).
- The settlement asset: any SEP-41 token. In practice it is Circle EURC or
  SG-FORGE EURCV, through their Stellar Asset Contract. Notes are
  denominated in EUR and settled at par in the token.
- The waterfall: at most 4 fee lines, the reserve rule, at most 4 triggers,
  and a normal order and an enforced order of at most 24 ranks each.

Three roles are three addresses: the admin (the "operator" of the
architecture document), the servicer and the reporter of the rate oracle. The
contract refuses a conflict with error 18 (`RoleConflict`).

The whitelist: the admin adds and removes holders with `set_eligible`. Only a
listed investor can subscribe (error 15, `NotEligible`). A note transfer needs
a listed receiver. A holder removed from the list keeps its notes, is still
paid, and can sell only to a listed holder.

At most 100 subscriptions are open at a time (`MAX_SUBSCRIPTIONS`, error 17).
The closing issues all the notes in one transaction, and the network limits
the event size of a transaction to 16 KB. A cancel to 0 frees the place.

`set_wiring` checks that each note token belongs to the deal and has its
denomination, and that the paying agent pays the deal's notes, in the same
order, in the deal's asset (error 14, `WiringMismatch`).

The issuer of the asset can freeze an account or claw back funds:

- A payout to the fees recipient or to the seller that fails is parked as an
  amount owed. The recipient takes it later with `claim_owed`. A frozen
  recipient never blocks the noteholders.
- The balance checks accept a surplus and stop on a deficit. A direct transfer
  to the deal cannot block it. A clawback stops the next period until someone
  sends the missing amount back. The maturity sweep pays a surplus to the
  seller.

Invariant: after every `distribute`, the asset balance of the deal is at least
the reserve plus the carry plus the amounts owed. Each payment date publishes
its rank lines (`rank_lines`) and its settlement figures (`period_settled`), so
a reader can check this invariant from the events.

The reference deal and Series 2 run an older code. Their balance check is
strict, so a transfer of 1 stroop to the deal blocks them. A full cancel followed by a new subscription of the same investor
issues its notes twice at the closing.

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

- EURC and EURCV have 7 decimals. The contracts work in base units of the
  asset and never read its decimals.
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

Series 4 replaces the reference deal and Series 2 in the client demos. It
runs the generalized code (whitelist, parked payouts, tolerant balance
checks, checked wiring) with the terms of the reference deal: Class A 100
notes, Class B 70, Class C 45, notes of 100 EURC, rounding to the cent, a
reserve of 500 and fees of 5 per period. It stays in the Funding phase. Its
whitelist starts empty: before a demo, the admin (`trueabs-admin`) adds each
demo wallet with `pnpm --filter spv-backend deal:eligible --deal <deal> --add <G...>`.

| Contract | Id |
|---|---|
| abs-deal | `CDP3NNLBJ7E5ZWJMUTMBPEJP2KB4UNOQ2KXMINAMO7NQAESQMKQ46SPL` |
| paying-agent | `CCLCDNQTWKGVGDH6XOC2FNEWVGOOC2KTO25JAJJHRPMP6M34QWO5K57S` |
| CARA7A4 | `CAETKS4EOU3X4DVDXAAD2XNADQVH7X5O5SZHPF5LIET53SEUBIMX637C` |
| CARA7B4 | `CAFYLMK5KHEQHRJVLIZR3RQWL6QIYKM5HVBP2ICAR2EDUCLBQP2UWASL` |
| CARA7C4 | `CCUAY4L765VO44BQCH76W7OAOVATKQ57TRQ4URUHRY57RLDKLIFOMFYZ` |

Code of Series 4 (wasm hashes): abs-deal
`7a607d144430c0439b343266c16867866dbc1e7618fcfe8d2cd315e8de56ac85`,
note-token `4498e0661fa55f2ee71899fe4bba88a49b4d2f195ee390905e1e01cf544201a2`,
paying-agent `667fc2fdea335f73a1e2a8a141eb4ba1525a4202124073cec059c45a5d8c1603`.

The demo EURC is a self-issued SAC:
`CBEO2RDQKBM7S3TYOYKBWAJEC6WMYPCW6JJWX47UCLFMUJI2EUZPJOXW`.

The Tranche 1 proof deals run the rank engine from one binary. Deals P and S
are matured. Deal C, the Dfns custody run of D3, is amortizing.
[evidence/](../evidence/README.md) holds their records.

| Contract | Deal P (pro rata, test EURC) | Deal S (sequential, Circle EURC) | Deal C (Dfns custody, test EURC) |
|---|---|---|---|
| abs-deal | `CCEW5FTOZHOPQLZPJESF7F6RCZCOVAEDIQDXU6FD66XGYINQKLJ4CQI3` | `CAYGDU72HJ6LBDOEEIFH2J3DTPCXECQ5WVTTCFZV6JVH76D2HXOEZRUF` | `CBNPFPUNWJEKX5EJHFS2BJI43V4DN4WWRGTDH44ZKEEN26ZGQWVHOQ2C` |
| paying-agent | `CBGB7CXQPGVBIDMPOZCYZU3ZS32YQYU26SJD3B5VA7IS2IHHVTMXRBHC` | `CCE6Q3XUOKX2CYBIHWGZPBYVSWONH3UJA6CYP2RLNJCXDKA4FPVSMZW4` | `CCP7LGA3W6GYEP2CFMIGMFILYDW5HWVDTOVYXNYEDEGQ6IFBCHTLJLQR` |
| Class A | `CC65LFMB2EUBCKVURUYE7ELZOFTDDVUCC5NG4ZNKU332QPWQBDIGVHJO` | `CDHQ6BBPIHHL4K4P3H2BT5K2AUG22E3WCQWCXAB7RGDDA72WTPP3FGKS` | `CAFJORGHJ63AQD55JATT5VX7LZ7WHNA25UQ74I73WL55IEA4FJB543IJ` |
| Class B | `CBKSDTYBZAQALDC2SLBYSN3ZTYMVJ24PPVKC5F42CKO2RDZKUOVNBDMT` | `CAUGR4VMYIUELXB2JV2RGBT76F2FHXAPMJ4XFWCGJXXYYJ7ONCTT44CL` | `CDNCI4CVPSD6LOJH3Z6N5OFPDWT6442SPO3Q6XFG4323DYG3DNOSQCYY` |
| Class C | `CC3BTSPG4PDOXYNRGCVPY5AVQ6QTQQY2UP3SIIBTBPLQTZCN7FIWUVM7` | `CDAMV6TE66DY3VZVF5UMEXGVTEJKJ35CGWSLSQUULH64EQUGOKQFJRM6` | `CAMNNSHHKJFYMPZSFSEMVZMT7INTIDFYASAJXRTZIZ6OPAV5MXBWPSFN` |
| Class D | none | `CBZHJDN6JMEFISE3DBZWAO3ETFNXKLATIKCENIZD2PLYJVBOHUGHKETY` | none |
| rate-oracle | `CAMRPVLUPYCMXAMDJXYSTSTUR3FC4JBDE3C7HOF2SMOQHK4KOQ4N2N5Z` | the same | `CATT7CLFJ5HMF62NCX3AQ644R47BKA37QCNO3JO2XGFJBP4XDI56O3F2` |

Code of these deals (wasm hashes): abs-deal
`5a5fedeaff280170ea28fb618a2587d992012e2fab4cab02504b7e50eaaead7a`,
note-token `4498e0661fa55f2ee71899fe4bba88a49b4d2f195ee390905e1e01cf544201a2`,
paying-agent `667fc2fdea335f73a1e2a8a141eb4ba1525a4202124073cec059c45a5d8c1603`,
rate-oracle `f30c751fea5b6940b21c6a1c0ea6265df6a62618b4838999f317bb98f00e7423`.

A contract is immutable, so one change of terms means one new deal instance.
The previous history stays on-chain under the old ids.

## Interface used by the fronts

`subscribe(investor, class, notes)` and `cancel(investor, class, notes)` on the
deal, the SEP-41 `transfer` on a note token, and `claim(holder)` on the paying
agent. There is no deposit, no withdraw and no redeem. An error surfaces as
`Error(Contract, #N)`.

## Build and test

```sh
cargo test --workspace     # 147 tests
stellar contract build     # wasm build, stellar-cli >= 25.2
```

Build the wasm with the Stellar CLI, not with raw cargo. The CLI must use the
rustup toolchain of `rust-toolchain.toml`: when another `cargo` comes first in
the `PATH` (for example Homebrew), run
`PATH="$HOME/.cargo/bin:$PATH" stellar contract build`. `target/` is ignored
by git.

The tests in `abs-deal/src/test_d2.rs` check the heavy calls against the
network limits of a transaction (200 writes, 400 footprint entries, 16 KB of
events, read from mainnet on 2026-11-17): `close` with 100 subscriptions and
`distribute` with 8 classes. The SDK enforces older, lower limits, so these
tests disable its check.
