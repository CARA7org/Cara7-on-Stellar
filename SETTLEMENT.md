# Deal shape and settlement asset: testnet runbook

One contract binary serves every deal. The configuration sets the class count
(1 to 8), the note denomination, the rounding unit and the settlement asset
(Circle EURC or SG-FORGE EURCV, through their Stellar Asset Contract). Notes
are denominated in EUR and settled at par in the token.

This runbook runs a full deal life on testnet on a configuration that differs
from the reference deal in all three points, and records the proof:

| | Reference deal | Demo deal |
|---|---|---|
| Classes | 3 | 4 (A floating, B to D fixed) |
| Note | 100 EURC | 10 EURC, rounding to the cent |
| Asset | self-issued test EURC | Circle's official testnet EURC |
| Period | 30 days | 90 days |
| Holders | free transfers | whitelist |

Proof of each step: the transaction hash with its stellar.expert link
(`https://stellar.expert/explorer/testnet/tx/<hash>`), the contract events,
and the per-holder counters of the paying agent. The recorded run is in
[Evidence](#evidence).

## Accounts

Local Stellar CLI identities. The CLI keystore holds the keys. The backend
holds none: it asks `stellar tx sign` for each operator signature
(`OPERATOR_SIGNER=stellar-cli`).

| Identity | Role |
|---|---|
| `d2-admin` | deal admin: wiring, whitelist, closing |
| `d2-servicer` | servicer: collections, `distribute` |
| `d2-reporter` | reporter of the demo oracle |
| `d2-crank` | deploys the contracts, pushes the holder payments |
| `d2-seller` | seller: subordinated loan, proceeds, residual |
| `d2-fees` | fees recipient, off the whitelist |
| `d2-inv-1` to `d2-inv-4` | investors |

Circle testnet EURC: `EURC:GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO`,
asset contract `CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ`.
The issuer sets no flag on testnet, so no account can be frozen there. The
failed-push path uses a removed trustline.

The demo oracle (EURIBOR 1M, reporter `d2-reporter`):
`CAMRPVLUPYCMXAMDJXYSTSTUR3FC4JBDE3C7HOF2SMOQHK4KOQ4N2N5Z`.

## 1. Prepare

1. Build the contracts with the rustup toolchain:
   `PATH="$HOME/.cargo/bin:$PATH" stellar contract build`.
2. Every EURC holder needs a trustline:
   `stellar tx new change-trust --source-account <identity> --line <EURC> --network testnet`.
3. Get 110 EURC from https://faucet.circle.com (EURC, Stellar Testnet): 100 for
   the notes, 5 for the reserve and 5 of margin for the collections. On
   2026-11-23, each request gave 20 EURC, so six addresses gave 120 EURC.
4. Move the EURC between the accounts: `d2-inv-1` 30, `d2-inv-2` 30,
   `d2-inv-3` 20, `d2-inv-4` 20, and at least 10 for `d2-seller`. `d2-inv-2`
   must hold exactly 30, because it removes its trustline after it subscribes.
5. Copy `apps/spv-backend/deals/d2-demo.testnet.json`. Fill the seller, the
   fees recipient and the whitelist. Do not put `d2-fees` on the whitelist.

## 2. Deploy

Start the indexer (`make dev-tranching`), then:

```sh
cd apps/spv-backend
export OPERATOR_SIGNER=stellar-cli CLI_ADMIN_IDENTITY=d2-admin \
  CLI_SERVICER_IDENTITY=d2-servicer CLI_REPORTER_IDENTITY=d2-reporter \
  CLI_CRANK_IDENTITY=d2-crank RATE_ORACLE_CONTRACT_ID=<the demo oracle>
pnpm deal:deploy --config <deal file> --from-deal <a deal of the same code> \
  --register http://localhost:8080 --save deploy.json
```

With no earlier deal, use `--wasm-dir ../../evidence/wasm`. The crank deploys
the deal, 4 note tokens and the paying agent. The admin wires the deal (the
wiring check runs) and sets the whitelist. Proof: the deploy hashes,
`set_wiring`, `eligibility_set` events.

## 3. Funding and closing

1. Each investor subscribes with `stellar contract invoke --source-account <investor>
   --id <deal> --network testnet -- subscribe --investor <investor> --class <n> --notes <n>`.
   `d2-inv-4` subscribes in two classes.
2. An address off the whitelist tries to subscribe. Proof: `Error(Contract, #15)`.
3. `d2-inv-3` cancels 1 note and subscribes it again. Proof: `sub_cancelled`.
4. The seller funds the reserve: `fund_sub_loan --amount 50000000`.
5. Start a backend on the deal (`DEAL_CONTRACT_ID`, `PAYING_AGENT_CONTRACT_ID`,
   `PORT=8097`, with `pnpm start`), then
   `curl -X POST http://localhost:8097/waterfall/close-deal`. Proof: the
   closing DvP, the `issue` events.

## 4. Payment dates

1. `d2-inv-2` removes its trustline. Its balance must be 0:
   `stellar tx new change-trust --source-account d2-inv-2 --line <EURC> --limit 0 --network testnet`.
2. Period 1: if the last fixing is more than 7 days old, the reporter publishes
   a new one with `pnpm oracle:push`. The seller sends EURC to the servicer for
   the collections, then
   `curl -X POST http://localhost:8097/waterfall/run-period -H 'content-type: application/json' -d '{"collections":"35"}'`.
   The crank pushes every holder. Proof: `holder_paid` for the others,
   `push_failed` for `d2-inv-2`.
3. `d2-inv-1` transfers 1 Class A note to a listed investor in the middle of
   the period, and fails to transfer one to an address off the list. Proof:
   the transfer, then `Error(Contract, #9)`.
4. Period 2: `curl http://localhost:8097/waterfall/period-preview` gives the
   amount that repays all the notes (`engine.payoffCollections`). Run the
   period with this amount. The deal matures.
5. `d2-inv-2` adds its trustline again and calls `claim` on the paying agent.
   Proof: `claimed`.

**Caution:** If every transfer of a `push_batch` can fail, send the batch
through the backend. Do not send it with `stellar contract invoke`. The
simulation then counts too few write bytes, and the network refuses the
transaction with `ResourceLimitExceeded`. The backend adds a margin
(`apps/spv-backend/src/waterfall/soroban.ts`).

## 5. Reconciliation

For each holder and each class, the paying agent counter
(`get_holder_totals`) equals the sum of its `holder_paid` and `claimed`
events. The deal balance equals the reserve plus the carry plus the amounts
owed (0 at maturity). The evidence tool checks these rules. Run it on the day
of the run, because Soroban RPC keeps the events for about 7 days:

```sh
DEAL_CONTRACT_ID=<deal> pnpm deal:evidence --deploy-log deploy.json \
  --compare-code <the other deal> --account <d2-inv-2> \
  --bundle events.json --out evidence.md
```

## Evidence

The run of 2026-11-23 used the code in [evidence/wasm](evidence/wasm/SHA256SUMS).
The deal is `CAYGDU72HJ6LBDOEEIFH2J3DTPCXECQ5WVTTCFZV6JVH76D2HXOEZRUF`. Its
paying agent is `CCE6Q3XUOKX2CYBIHWGZPBYVSWONH3UJA6CYP2RLNJCXDKA4FPVSMZW4`.
[evidence/deal-s/evidence.md](evidence/deal-s/evidence.md) lists every
transaction and every check.

| Step | Transaction |
|---|---|
| The admin wires the deal. The contract checks the note tokens and the paying agent. | [`eccbcc6c9177...`](https://stellar.expert/explorer/testnet/tx/eccbcc6c91776304983fc008a5ad92dcaf158fbc7fdf9686d5eee7f781a833c9) |
| The admin sets the whitelist of 4 investors. | [`8d3d545eed98...`](https://stellar.expert/explorer/testnet/tx/8d3d545eed9844071aa4319d1725a9edb4ef10bde240468082bf3631bc8cb11b) |
| `d2-fees`, off the whitelist, tries to subscribe. | Refused: `Error(Contract, #15)` |
| `d2-inv-1` subscribes 3 Class A notes. | [`2fb5221b3a0c...`](https://stellar.expert/explorer/testnet/tx/2fb5221b3a0c3426406c05d1d7713c86044b30d967523460bde09fc73117dc1a) |
| `d2-inv-4` subscribes 1 Class A note. | [`d48f07b34be7...`](https://stellar.expert/explorer/testnet/tx/d48f07b34be799eb636c3e79e921971438869e6495e63c99aa1f6fa9e3ded473) |
| `d2-inv-2` subscribes 3 Class B notes. | [`fb73d204720f...`](https://stellar.expert/explorer/testnet/tx/fb73d204720f98702c0a27dc7ce5fa6efd5f38128b6f44150019d488fef3a5f2) |
| `d2-inv-3` subscribes 2 Class C notes. | [`93cfb5470916...`](https://stellar.expert/explorer/testnet/tx/93cfb5470916ce9e11957baf94dc904607a24120bf27589fb135bc83e3a30362) |
| `d2-inv-4` subscribes 1 Class D note. | [`d8c6c3219695...`](https://stellar.expert/explorer/testnet/tx/d8c6c321969599f4307aa7d46da63ce9a9b544e905c881c50157380ea4f31484) |
| `d2-inv-3` cancels 1 Class C note. | [`c6a0ad5828cb...`](https://stellar.expert/explorer/testnet/tx/c6a0ad5828cbeffa9c8b6bee56673cbdfb19bf39ed0aab26c3ce47812dd70794) |
| `d2-inv-3` subscribes this note again. | [`1ee1f77c9691...`](https://stellar.expert/explorer/testnet/tx/1ee1f77c969120e698a3b5e2fb2522fe980ad4099a09856a8e17e9bdacca5f1c) |
| The seller funds the subordinated loan of 5 EURC. | [`3009dd66743b...`](https://stellar.expert/explorer/testnet/tx/3009dd66743b886f9a22ca764724e8ee4ca976d1aff6a90247daac6122465c15) |
| Closing DvP: 100 EURC to the seller, 5 EURC to the reserve, 10 notes issued. | [`9880e8c3d4e0...`](https://stellar.expert/explorer/testnet/tx/9880e8c3d4e0a639ed3ff701a1fc53f35db11f7f468f117fb62bc6e73bcc0e0a) |
| `d2-inv-2` removes its trustline. | [`13eba94c65d0...`](https://stellar.expert/explorer/testnet/tx/13eba94c65d097722907dafc3608afac48bbd21ea00726d84d0e80bacae88068) |
| Period 1: principal goes to Class A only. | [`ba25223c424b...`](https://stellar.expert/explorer/testnet/tx/ba25223c424b0964faf9b70ff0eb6ed6f7fd7acb66e56ac6e24a8cf5b23ddd03) |
| The push to `d2-inv-2` fails. The payment waits in the paying agent. | [`882c258f4156...`](https://stellar.expert/explorer/testnet/tx/882c258f41565abc7ee0969d55d00e2b2878abfb0f877ee7ee413fc7aca8ad0d) |
| `d2-inv-1` transfers 1 Class A note to `d2-inv-3`. | [`976075eaedd1...`](https://stellar.expert/explorer/testnet/tx/976075eaedd1dd8628b939ca17098b6a7cf18a9472a4f08ae21414e1a8e29c02) |
| `d2-inv-1` tries to transfer a note to `d2-fees`. | Refused: `Error(Contract, #9)` |
| Period 2: all the notes are repaid and the deal matures. | [`4427c76e7479...`](https://stellar.expert/explorer/testnet/tx/4427c76e7479923ea6be5bf82871b115c1007c2d8fdbc64250cbb1838bf269bf) |
| The second push to `d2-inv-2` fails. | [`8833efadbe8b...`](https://stellar.expert/explorer/testnet/tx/8833efadbe8b8f487554e86cc216826f271acc4f6e6397f34f3738626cc9bf19) |
| `d2-inv-2` adds its trustline again. | [`42a75113f9ff...`](https://stellar.expert/explorer/testnet/tx/42a75113f9ff2b5e591b1aef61f1f85acef7c5615237ae6db029abe44b330fa1) |
| `d2-inv-2` claims its 30.18 EURC. | [`77b55cc14d56...`](https://stellar.expert/explorer/testnet/tx/77b55cc14d56f509ec11a2c83ae1554d2379e36ab907ab720a5bfbb6b280d738) |

### Payment dates

| Period | Collections | Principal rank | Principal A | Principal B | Principal C | Principal D | Factors after (%) | `distribute` |
|---|---|---|---|---|---|---|---|---|
| 1 | 35 | `principal` | 34.24 | 0 | 0 | 0 | 14.40 / 100.00 / 100.00 / 100.00 | [`ba25223c424b...`](https://stellar.expert/explorer/testnet/tx/ba25223c424b0964faf9b70ff0eb6ed6f7fd7acb66e56ac6e24a8cf5b23ddd03) |
| 2 | 66.1719096 | `principal` | 5.76 | 30 | 20 | 10 | 0.00 / 0.00 / 0.00 / 0.00 | [`4427c76e7479...`](https://stellar.expert/explorer/testnet/tx/4427c76e7479923ea6be5bf82871b115c1007c2d8fdbc64250cbb1838bf269bf) |

### Reconciliation

For each row, the counter of the paying agent equals the sum of the
`holder_paid` and `claimed` events of the holder (check H1). `d2-inv-2`
received its 30.18 EURC through `claim`.

| Class | Holder | Notes | Interest received | Principal received | Waits in the paying agent |
|---|---|---|---|---|---|
| A | `d2-inv-1` | 2 | 0.237 | 28.56 | 0 |
| A | `d2-inv-4` | 1 | 0.08 | 10 | 0 |
| A | `d2-inv-3` | 1 | 0.003 | 1.44 | 0 |
| B | `d2-inv-2` | 3 | 0.18 | 30 | 0 |
| C | `d2-inv-3` | 2 | 0.24 | 20 | 0 |
| D | `d2-inv-4` | 1 | 0.2 | 10 | 0 |
| Total |  | 10 | 0.94 | 100 | 0 |

The deal is matured. Its reserve, its carry and its amounts owed are 0. The
evidence tool gives PASS on its 16 checks.
