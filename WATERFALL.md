# Configurable waterfall: the rank engine

The `abs-deal` contract runs the priority of payments from a rank list in its
configuration. A new deal structure is a new deal file, not a new contract.
One contract binary runs all the structures.

Two recorded testnet deals run different structures from the same binary:

| | Deal P | Deal S |
|---|---|---|
| Principal | Pro rata, then sequential after a trigger | Sequential |
| Classes | 3 (A floating, B and C fixed) | 4 (A floating, B to D fixed) |
| Fee lines | 2: a fixed fee and a fee per year | 1: a fixed fee |
| Reserve | 5 % of the notes, floor of 20 EURC, drawn on need | 5 EURC, released in full |
| Interest of Class C | Ranks below the reserve re-fund | Ranks above the reserve re-fund |
| Trigger | `seq`: notes factor below 50 %, latched | None |
| Period | 30 days | 90 days |
| Asset | Self-issued test EURC | Circle testnet EURC |

The deal files are
[`d1-prorata.testnet.json`](apps/spv-backend/deals/d1-prorata.testnet.json) and
[`d2-demo.testnet.json`](apps/spv-backend/deals/d2-demo.testnet.json).

## 1. The deal file

A version 2 deal file has a `waterfall` block. The deploy tool
(`pnpm deal:deploy`) encodes this block in the `DealConfig` argument of the
constructor. A version 1 file still loads: the tool gives it the reference
order.

| Field | Values | Meaning |
|---|---|---|
| `fees` | At most 4 lines | Each line has a `recipient` and an `amount`. |
| `fees[].amount` | `fixed` (`amount`) or `perAnnum` (`ratePct`) | An amount for each period, or a rate per year on the opening balance of the notes. |
| `reserve.required` | `fixed` (`amount`) or `pctOfNotes` (`pct`, `floor`) | The required reserve. |
| `reserve.release` | `full` or `onNeed` | `full`: the whole reserve enters the cash of the period, and a rank re-funds it. `onNeed`: the reserve stays in its ledger and covers the shortfall of a draw rank. |
| `reserve.drawRanks` | Rank ids | The ranks that can draw on an `onNeed` reserve. |
| `triggers` | At most 4 | Each trigger has an `id`, a `metric`, an `op` (`gt`, `ge`, `lt`, `le`), a `threshold` and a `latch`. |
| `triggers[].metric` | `notesFactor`, `classFactor`, `reserveShortfall`, `classShortfall` | A value of the opening ledgers. The threshold of a factor is a percent. The threshold of a shortfall is an amount of the asset. |
| `normal`, `enforced` | 1 to 24 ranks, at most 40 items | The order before and after `set_enforced`. |
| rank `id` | 1 to 16 letters, digits or `_` | The name of the rank in the events. |
| rank `when` | `trigger` or `notTrigger`, with a trigger id | The rank runs only when this condition is true. With no `when`, the rank always runs. |
| rank `alloc` | `sequential` or `pariPassu` | How the rank shares its cash between its items. |
| rank `items` | 1 to 8 | `fee` (`index`), `interest` (`class`), `principal` (`class`), `reserveRefill` or `residual`. |

A floating rate can also have `floorPct` (a floor of the all-in rate) and
`indexFloorPct` (a floor of the index).

Two ranks with opposite conditions give a switch. In deal P, principal is pro
rata until the trigger `seq` is set, then sequential:

```json
{ "id": "prin_pr", "when": { "kind": "notTrigger", "id": "seq" }, "alloc": "pariPassu",
  "items": [{ "kind": "principal", "class": "A" }, { "kind": "principal", "class": "B" }, { "kind": "principal", "class": "C" }] },
{ "id": "prin_seq", "when": { "kind": "trigger", "id": "seq" }, "alloc": "sequential",
  "items": [{ "kind": "principal", "class": "A" }, { "kind": "principal", "class": "B" }, { "kind": "principal", "class": "C" }] }
```

## 2. What the contract refuses

The constructor runs `validate` (`contracts/abs-deal/src/validate.rs`). It
refuses a configuration with error 5 (`InvalidConfig`) in these cases:

- A class, a fee line or a trigger is out of range or unknown.
- Two ranks of one order, or two triggers, have the same id.
- An item can run twice, or not at all. An item must be in one rank that
  always runs, or in two ranks with the conditions `trigger X` and
  `notTrigger X`.
- The principal of a class ranks before its interest.
- A `pariPassu` rank holds items of different kinds, or a reserve or residual
  item.
- The residual is not alone in the last rank, or this rank has a condition.
- The reserve can hold cash, and the normal order has no `reserveRefill` item.
- A draw rank is unknown, is not in the normal order, or holds an item other
  than a fee or an interest. A `full` reserve has no draw rank.

The constructor refuses `admin == servicer` with error 18 (`RoleConflict`).

## 3. One payment date

`distribute(period, collections)` runs these steps:

1. **Interest due.** For each class, the contract accrues
   `opening notes x rate x days / 360` and adds the unpaid interest of the
   earlier periods. Unpaid interest earns no interest.
2. **Required reserve.** It is 0 after enforcement or when all the notes are
   repaid. Else it is the fixed amount, or the larger of the floor and
   `pct x opening notes`.
3. **Triggers.** The contract compares each metric with its threshold, on the
   opening ledgers. A latched trigger stays set.
4. **Available cash.** The cash is the collections, the carry and the released
   reserve. `full` releases the whole reserve. `onNeed` releases only the
   amount above the required reserve.
5. **Ranks.** The contract runs the ranks in order and skips a rank when its
   condition is false:
   - An `onNeed` draw rank with a shortfall first takes
     `min(shortfall, reserve)` from the reserve.
   - If the cash covers all the dues of the rank, each item receives its due.
   - Else a `sequential` rank pays its items in order.
   - Else a `pariPassu` rank gives each item `floor(cash x due / total due)`.
     The units that are left go to the first items.
6. **Rounding.** Interest and principal are paid per note and rounded down to
   the `round_unit`. The remainder goes to the carry.
7. **Residual.** The cash that is left goes to the seller. At maturity, the
   seller also receives the reserve, the carry and any surplus. The contract
   keeps only the amounts owed.

Principal is turbo: a principal item receives all the cash after the ranks
above it, up to the balance of its class.

## 4. Roles

| Role | Address | Operations |
|---|---|---|
| `admin` (the "operator" of the architecture document) | `admin` in the configuration | `set_wiring`, `set_eligible`, `abort`, `close`, `set_enforced`, `set_servicer` |
| Servicer | `servicer` in the configuration | `distribute` |
| Reporter | `get_reporter` of the rate oracle | `set_rate` on `rate-oracle` |

The contract enforces the separation with error 18 (`RoleConflict`):

- The constructor refuses `admin == servicer`, and `set_servicer` refuses the
  admin.
- `close` and `distribute` of a deal with a floating class read the reporter
  of the oracle. They refuse when this call fails, or when the reporter is the
  admin or the servicer.

**Caution:** If you deploy a production deal, give its oracle an admin that
holds no role in the deal. The admin of a rate oracle can replace the reporter
with `set_reporter`, and `abs-deal` does not check this address. On deals P and
S, the demo oracle has `d2-admin` as its admin, and `d2-admin` is also the deal
admin.

`contracts/abs-deal/src/test_roles.rs` gives the proof. Each of the admin, the
servicer, the reporter and a stranger tries each operation, with the real
`rate-oracle` contract. Only the role that owns the operation passes.

## 5. Events

The contract keeps all its earlier events. Each payment date adds:

| Event | Topic | Data |
|---|---|---|
| `rank_lines` | `period` | `enforced`, and one line for each item with a due above 0: rank id, item, due, paid, dust |
| `period_settled` | `period` | `collections`, `reserve_in`, `carry_in`, `drawn`, `paid_out`, `reserve`, `carry`, `owed`, `balance`, `surplus` |
| `trigger_breached` | `id` | The period in which the trigger became set |

The contract checks two rules at each payment date. A reader can check them
again from `period_settled` alone:

- Conservation: `collections + reserve_in + carry_in = paid_out + reserve + carry`.
- Balance invariant: `balance >= reserve + carry + owed`.

## 6. Run a deal

This runbook uses the local Stellar CLI identities of
[SETTLEMENT.md](SETTLEMENT.md). The steps are those of deal P.

1. Copy `apps/spv-backend/deals/d1-prorata.testnet.json`. Fill the seller, the
   whitelist and the two fee recipients.
2. Start the indexer (`make dev-tranching`), then deploy:
   ```sh
   cd apps/spv-backend
   export OPERATOR_SIGNER=stellar-cli CLI_ADMIN_IDENTITY=d2-admin \
     CLI_SERVICER_IDENTITY=d2-servicer CLI_REPORTER_IDENTITY=d2-reporter \
     CLI_CRANK_IDENTITY=d2-crank RATE_ORACLE_CONTRACT_ID=<oracle of the deal>
   pnpm deal:deploy --config <deal file> --wasm-dir ../../evidence/wasm \
     --register http://localhost:8080 --save deploy.json
   ```
3. Each investor subscribes (6 Class A notes, 3 Class B notes, 1 Class C note):
   ```sh
   stellar contract invoke --source-account <investor> --id <deal> --network testnet \
     -- subscribe --investor <investor> --class <n> --notes <n>
   ```
4. The seller funds the reserve: `fund_sub_loan --amount 500000000`.
5. Start a backend on the deal and close it:
   ```sh
   DEAL_CONTRACT_ID=<deal> PAYING_AGENT_CONTRACT_ID=<paying agent> PORT=8096 pnpm start
   curl -X POST http://localhost:8096/waterfall/close-deal
   ```
6. The reporter publishes the fixing: `pnpm oracle:push`.
7. For each period, the seller sends the collections to the servicer. Then run
   the payment date, with 305, 305 and 105:
   ```sh
   curl -X POST http://localhost:8096/waterfall/run-period \
     -H 'content-type: application/json' -d '{"collections":"305"}'
   ```
8. Read the amount that repays all the notes, then run the last payment date
   with it. The field is `engine.payoffCollections`:
   ```sh
   curl http://localhost:8096/waterfall/period-preview
   ```
9. On the day of the run, record the evidence:
   ```sh
   DEAL_CONTRACT_ID=<deal> pnpm deal:evidence --deploy-log deploy.json \
     --bundle events.json --out evidence.md
   ```

## 7. Evidence

The records are in [evidence/](evidence/README.md). The evidence tool reads
them from the network and gives PASS on its 16 checks for each deal.

| Completion measure | Proof |
|---|---|
| Different structures from one binary | Deals P and S have the same code hashes (check B1). |
| A complete distribution period for each | Deal P: 4 payment dates. Deal S: 2 payment dates. Both deals ran to maturity. |
| Rank-by-rank allocation through events | `rank_lines` of each period (checks C2, C3, C7), and a replay with a second copy of the engine (check C8). |
| Balance invariant through events | `period_settled` of each period (checks C4, C5). |
| Each role rejected on the others' operations | `test_roles.rs`, and three separate addresses on each deal (check R1). |

| Deal | Contract | Report |
|---|---|---|
| P | `CCEW5FTOZHOPQLZPJESF7F6RCZCOVAEDIQDXU6FD66XGYINQKLJ4CQI3` | [evidence/deal-p/evidence.md](evidence/deal-p/evidence.md) |
| S | `CAYGDU72HJ6LBDOEEIFH2J3DTPCXECQ5WVTTCFZV6JVH76D2HXOEZRUF` | [evidence/deal-s/evidence.md](evidence/deal-s/evidence.md) |

The `abs-deal` code of both deals has the hash
`5a5fedeaff280170ea28fb618a2587d992012e2fab4cab02504b7e50eaaead7a`.

Deal P, pro rata. In periods 1 and 2, each note receives the same principal.
The notes factor then falls below 50 %, so period 3 sets `seq` and pays
Class A only:

| Period | Collections | Principal rank | Principal A | Principal B | Principal C | Factors after (%) | `distribute` |
|---|---|---|---|---|---|---|---|
| 1 | 305 | `prin_pr` | 180.36 | 90.18 | 30.06 | 69.94 / 69.94 / 69.94 | [`5846de605e05...`](https://stellar.expert/explorer/testnet/tx/5846de605e051691611313c7041ee971a60bb995934ab7c71d58bc87633c906a) |
| 2 | 305 | `prin_pr` | 190.08 | 95.04 | 31.68 | 38.26 / 38.26 / 38.26 | [`b7010f2393cb...`](https://stellar.expert/explorer/testnet/tx/b7010f2393cb57451ed7ccdf3c1ba803204df0a58a6d1bd1c20b240e427e32f7) |
| 3 | 105 | `prin_seq` | 117.72 | 0 | 0 | 18.64 / 38.26 / 38.26 | [`98abe04941f6...`](https://stellar.expert/explorer/testnet/tx/98abe04941f62fb4cde9d6e1f063e8e70e44035f47ce970a4661bcd98eec6e7c) |
| 4 | 266.6831986 | `prin_seq` | 111.84 | 114.78 | 38.26 | 0.00 / 0.00 / 0.00 | [`580b69bb648d...`](https://stellar.expert/explorer/testnet/tx/580b69bb648d58210839c6b35d04b8d06ef89e23e6e2dd5aa36d3f18ce842884) |

Deal S, sequential. Class A receives all the principal until it is repaid:

| Period | Collections | Principal rank | Principal A | Principal B | Principal C | Principal D | Factors after (%) | `distribute` |
|---|---|---|---|---|---|---|---|---|
| 1 | 35 | `principal` | 34.24 | 0 | 0 | 0 | 14.40 / 100.00 / 100.00 / 100.00 | [`ba25223c424b...`](https://stellar.expert/explorer/testnet/tx/ba25223c424b0964faf9b70ff0eb6ed6f7fd7acb66e56ac6e24a8cf5b23ddd03) |
| 2 | 66.1719096 | `principal` | 5.76 | 30 | 20 | 10 | 0.00 / 0.00 / 0.00 / 0.00 | [`4427c76e7479...`](https://stellar.expert/explorer/testnet/tx/4427c76e7479923ea6be5bf82871b115c1007c2d8fdbc64250cbb1838bf269bf) |

### Network limits

On 2026-11-23, a rehearsal deal with 8 classes, 4 fee lines, 4 triggers and
24 ranks ran on testnet (`CA56NDUYIXPMWX22CIP7S5OIDQ74EM3EQEJQKCW66QZ7WPJAYGRYAUHS`).
This table gives its largest `distribute`:

| Resource | Used | Limit of a transaction |
|---|---|---|
| Instructions | 21,573,315 | 400,000,000 |
| Event bytes | 12,488 | 16,384 |
| Write bytes | 22,716 | 132,096 |
| Written entries | 30 | 200 |
| Footprint entries | 46 | 400 |
