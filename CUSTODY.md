# Dfns custody: setup and testnet runbook

CARA7 has two signing paths. A self-custody investor signs in a browser
wallet (Stellar Wallets Kit). An institutional investor and the operator roles
sign through Dfns policy wallets. Dfns signs only: CARA7 builds, simulates and
submits every transaction with its own Soroban RPC and Horizon, and the
tranching-api indexer reads the contract events.

## Trust model

| Wallet | Tag | Who starts a signature | Who approves |
|---|---|---|---|
| Investor (one per investor) | `cara7:investor` | custody-api, after a passkey login | the checker below the threshold, a person above it |
| Deal admin | `cara7:admin` | spv-backend | a person, for every signature |
| Servicer | `cara7:servicer` | spv-backend | a person, for every signature |
| Oracle reporter | `cara7:reporter` | spv-backend | a person, for every signature |
| Crank | `cara7:crank` | spv-backend | nobody: it only calls the permissionless `push_batch` and holds only XLM |

- The custody-api guard and the checker apply the same rules
  (`apps/custody-api/src/policy/evaluate.ts`). An investor wallet may only
  call `subscribe` and `cancel` on a listed deal, call `claim` on its paying
  agent, and change its EURC trustline.
- The checker approves an allowed request at or below the threshold
  (`thresholdEurc` in `apps/custody-api/src/policy/testnet.json`). It does not
  vote on a larger subscription, so a person decides in app.dfns.io. It
  denies every other request.
- The backends hold Dfns service account credentials. These credentials
  authenticate API calls. They are not Stellar keys, and the policies above
  still apply to every signature that they request.
- CARA7 holds the investor wallets in its Dfns organization. CARA7 is then
  probably the custodian of these funds. Get a legal opinion before mainnet.

## 1. Dfns organization

Do these steps in app.dfns.io.

1. Ask Dfns support to enable `serviceAccountsCanApprove` for the
   organization. The checker cannot vote without it.
2. Create three service accounts. Each one gets its own key pair, made on
   your machine (`openssl genpkey -algorithm ed25519 -out <name>.pem`, then
   `openssl pkey -in <name>.pem -pubout`). Give Dfns the public key only.

   | Service account | Used by | Permissions |
   |---|---|---|
   | `cara7-operator` | `apps/spv-backend` | `Wallets:Read`, `Keys:Signatures:Create`, `Keys:Signatures:Read` |
   | `cara7-custody` | `apps/custody-api` server | `Wallets:Create`, `Wallets:Tags:Add`, `Wallets:Read`, `Keys:Signatures:Create`, `Keys:Signatures:Read` |
   | `cara7-checker` | `apps/custody-api` checker | `Wallets:Read`, `Policies:Evaluations:Read`, `Policies:Evaluations:Vote` |

   Check the permission names in the dashboard: Dfns can rename them. If
   Dfns refuses the investor wallet creation, add `Keys:Create` to
   `cara7-custody`.
3. Create four wallets on `StellarTestnet` and tag them: `cara7:admin`,
   `cara7:servicer`, `cara7:reporter`, `cara7:crank`. Fund each address with
   Friendbot (`https://friendbot.stellar.org/?addr=<address>`). custody-api
   creates the investor wallets itself.
4. Create two policies (activity `Wallets:Sign`, rule `AlwaysTrigger`, action
   `RequestApproval`). Put your own user id in place of `us-you` and the
   checker's user id in place of `us-checker`.

   Operator approval (the time bound of an operator transaction is 60 minutes):
   ```json
   {
     "name": "CARA7 operator approval",
     "activityKind": "Wallets:Sign",
     "rule": { "kind": "AlwaysTrigger" },
     "action": {
       "kind": "RequestApproval",
       "autoRejectTimeout": 50,
       "approvalGroups": [
         { "name": "Operator approvers", "quorum": 1,
           "approvers": { "userId": { "in": ["us-you"] } },
           "initiatorCanApprove": false }
       ]
     },
     "filters": { "walletTags": { "hasAny": ["cara7:admin", "cara7:servicer", "cara7:reporter"] } }
   }
   ```

   Investor checker (the time bound of an investor transaction is 30 minutes):
   ```json
   {
     "name": "CARA7 investor checker",
     "activityKind": "Wallets:Sign",
     "rule": { "kind": "AlwaysTrigger" },
     "action": {
       "kind": "RequestApproval",
       "autoRejectTimeout": 25,
       "approvalGroups": [
         { "name": "Checker or risk officer", "quorum": 1,
           "approvers": { "userId": { "in": ["us-you", "us-checker"] } },
           "initiatorCanApprove": false,
           "serviceAccountsCanApprove": true }
       ]
     },
     "filters": { "walletTags": { "hasAny": ["cara7:investor"] } }
   }
   ```
   Do not put a policy on `cara7:crank`.
5. Put the values in `apps/spv-backend/.env` and `apps/custody-api/.env`
   (see their `.env.example`). In production, run the checker on its own host
   with only the `CHECKER_` variables.

## 2. Testnet runbook

This runbook proves the six points of D3 on a new small deal, deal C. Deal C
runs the same contract code as deals P and S ([evidence/](evidence/README.md)).
Its admin, servicer, oracle reporter and crank are the Dfns wallets. The
reference deal stays out of this run.

Deal C has 18 notes of 100 EURC (Class A 10, Class B 5, Class C 3), on the
self-issued test EURC, with a reserve of 100 EURC. The policy threshold is
250 EURC. A subscription of 2 notes passes with the checker. A subscription of
3 or more notes needs a person.

Each step names the proof that it gives. Give absolute paths to the commands
that use `pnpm --filter`, because they run in the folder of the app.

### Prepare the deal

1. Put `apps/spv-backend/.env` and `apps/custody-api/.env` in place (section
   1). Check the four wallets. The output must name the signer `dfns`:
   `pnpm --filter spv-backend custody:status`.
2. Deploy the oracle of deal C. Its reporter is the Dfns reporter wallet. Its
   admin can replace the reporter, so this address must hold no role in the
   deal. Use the local identity `d2-admin`:
   ```sh
   stellar contract deploy --wasm evidence/wasm/rate_oracle.wasm \
     --source-account d2-crank --network testnet -- \
     --admin <d2-admin G-address> --reporter <reporter G-address> \
     --max_staleness_secs 604800 --max_deviation_bps 500
   ```
3. Give the servicer wallet its EURC trustline (one approval). Then send it
   400 EURC for the collections:
   ```sh
   pnpm --filter spv-backend custody:trust --role servicer
   stellar contract invoke --network testnet --source-account trueabs-admin \
     --id CBEO2RDQKBM7S3TYOYKBWAJEC6WMYPCW6JJWX47UCLFMUJI2EUZPJOXW -- transfer \
     --from GCV6OX6GKQOJJGD3DTF5AIENK3EKR64OPHCNCX5MGZUT2KTDD5QGFFRI \
     --to <servicer G-address> --amount 4000000000
   ```
4. Start `make dev-tranching`, `make dev-custody`, `make dev-checker` and
   `make dev-defi`. In the front (http://localhost:3001), select "Dfns policy
   wallet" and create an account with a passkey. custody-api creates the
   wallet and funds it with Friendbot. Note its address, because the whitelist
   of the deal needs it before the deploy.
5. Copy `apps/spv-backend/deals/custody-demo.testnet.json`. Fill the oracle of
   step 2, the investor wallet and the browser wallet of step 14.
6. Deploy the deal with the code of deal S. The crank wallet deploys. The
   admin wallet signs the wiring and the whitelist (two approvals):
   ```sh
   pnpm --filter spv-backend deal:deploy --config <deal file> \
     --from-deal CAYGDU72HJ6LBDOEEIFH2J3DTPCXECQ5WVTTCFZV6JVH76D2HXOEZRUF \
     --register http://localhost:8080 --save <deploy file>
   ```
7. Add the printed entry at the end of `deals` in
   `apps/custody-api/src/policy/testnet.json`. Restart custody-api and the
   checker, because they read the policy when they start. Then start a second
   backend on the deal:
   ```sh
   DEAL_CONTRACT_ID=<deal> PAYING_AGENT_CONTRACT_ID=<paying agent> \
     RATE_ORACLE_CONTRACT_ID=<oracle> PORT=8092 pnpm --filter spv-backend start
   ```

### Investor path

8. Investor, in the front, on deal C: "Enable EURC". Proof: the policy wallet
   signs a classic ChangeTrust.
9. Send 700 EURC to the investor wallet (the `transfer` of step 3).
10. Class A: subscribe 2 notes (200 EURC). The checker approves. Proof:
    subscribe.
11. Subscribe 3 notes (300 EURC). The front shows "Awaiting approval". Reject
    the request in app.dfns.io. Proof: the front shows "Your policy approver denied
    this action". No transaction exists, so record the approval id and the
    `signing_request` row (status, reason).
12. Subscribe 5 notes (500 EURC). Approve the request in app.dfns.io. Proof: an
    action above the threshold completes after a second approval.
13. Cancel 1 note, then subscribe 1 note. Proof: cancel. The investor now holds
    7 Class A subscriptions and 0 EURC.
14. Self-custody: a Wallets Kit wallet adds its EURC trustline in its own
    interface (in Freighter: "Add token", then the contract id of the asset).
    The front does not do this step for a self-custody wallet. The wallet
    receives 100 EURC. It subscribes 1 Class B note, then cancels it. Proof:
    the self-custody path is unchanged.

### Closing and payment date

15. Fill the other subscriptions from the seller account, fund the subordinated
    loan, then close (one admin approval):
    ```sh
    SELLER=GCV6OX6GKQOJJGD3DTF5AIENK3EKR64OPHCNCX5MGZUT2KTDD5QGFFRI
    subscribe() { stellar contract invoke --network testnet --source-account trueabs-admin \
      --id <deal> -- subscribe --investor "$SELLER" --class "$1" --notes "$2"; }
    subscribe 0 3; subscribe 1 5; subscribe 2 3
    stellar contract invoke --network testnet --source-account trueabs-admin --id <deal> -- \
      fund_sub_loan --amount 1000000000
    curl -X POST http://localhost:8092/waterfall/close-deal
    curl http://localhost:8092/operations/<operation id>   # after the approval
    ```
16. Investor: "Remove EURC trustline" in the wallet menu. The first payment
    then cannot reach the wallet and waits on the paying agent.
17. Payment date. The reporter and the servicer each need one approval:
    ```sh
    RATE_ORACLE_CONTRACT_ID=<oracle> pnpm --filter spv-backend oracle:push
    curl -X POST http://localhost:8092/waterfall/run-period \
      -H 'content-type: application/json' -d '{"collections":"300"}'
    curl http://localhost:8092/operations/<operation id>   # after the approval
    ```
    The operation shows the `distribute` hash and the crank pushes. Proof: a
    payment date through the custodied operator key.
18. Investor: "Enable EURC", then "Claim". Proof: claim, and a second
    ChangeTrust.
19. No raw secret. The first command must print nothing, and the second must
    print 0. The tests "configuration holds no Stellar secret" must pass:
    ```sh
    grep -rn SERVICER_SECRET apps --include='*.ts' --include='*.example' --exclude-dir=node_modules
    grep -cE '^[A-Z_]+=S[A-Z2-7]{55}$' apps/spv-backend/.env
    pnpm --filter spv-backend exec vitest run test/custody.test.ts
    ```
20. On the day of the run, record the evidence:
    ```sh
    DEAL_CONTRACT_ID=<deal> pnpm --filter spv-backend deal:evidence \
      --deploy-log <deploy file> \
      --compare-code CAYGDU72HJ6LBDOEEIFH2J3DTPCXECQ5WVTTCFZV6JVH76D2HXOEZRUF,CCEW5FTOZHOPQLZPJESF7F6RCZCOVAEDIQDXU6FD66XGYINQKLJ4CQI3 \
      --account <investor G-address>,<browser G-address> \
      --bundle <events file> --out <report file>
    ```

## Testnet notes

- Dfns rejects a pending approval after 50 minutes for an operator signature
  and after 25 minutes for an investor signature.
- The trial and Starter plans give 1 user and 100 signatures per month. The
  runbook uses about 23 signatures.

## Evidence

The run of 2026-11-24 used the code in [evidence/wasm](evidence/wasm/SHA256SUMS).
Deal C is `CBNPFPUNWJEKX5EJHFS2BJI43V4DN4WWRGTDH44ZKEEN26ZGQWVHOQ2C`. Its paying
agent is `CCP7LGA3W6GYEP2CFMIGMFILYDW5HWVDTOVYXNYEDEGQ6IFBCHTLJLQR` and its
oracle is `CATT7CLFJ5HMF62NCX3AQ644R47BKA37QCNO3JO2XGFJBP4XDI56O3F2`.
[evidence/deal-c/evidence.md](evidence/deal-c/evidence.md) lists every
transaction and every check. Fifteen checks pass. The check L2 does not apply,
because deal C is not matured. The check B1 shows that deal C runs the same
code as deals P and S.

| Wallet | Address |
|---|---|
| Investor, Dfns policy wallet | `GDCXLJCUWFHD56327BBOCTGY3ICMDLOSOSQJE37IZOWZP7UWL2HUNIWV` |
| Investor, self-custody wallet (Freighter) | `GBYGTYZK2FWRJ7KTTWBMXIUMHZXO7GFM6KQ6C45Y3Q6W3ABTWBJ5KY7V` |
| Deal admin | `GAETDRSUVCR3WIMUXDSMTMG3ZVTYVLGIEW4C4ISPTWZWEEVM436ZCMHK` |
| Servicer | `GBHYXZJPKYQA4L4N52LUFSKRZ4QKZHKDEPUWMNEBTOACGA5T3IMKYNSG` |
| Oracle reporter | `GAQ7GZ2OSPIPIIF6WQ5XPHZJZ4IPOSZVH6X4IOHGWT32CYJB45ZJUIQM` |
| Crank | `GAJ2IQ2UCUFFGJYSLAJOHTOIKEDQXETWXRJ6I6YD2RPJABY3J5J5REHO` |

### The six points of D3

| D3 point | Proof |
|---|---|
| An investor subscribes, cancels and claims from a policy wallet. | Subscribe 2 Class A notes: [`5edaab51eb1d...`](https://stellar.expert/explorer/testnet/tx/5edaab51eb1d20e92afc08fac2e36c7a1647f655ebe2ff4d04da1c059792e91c). Cancel 1 note: [`d5e1bd52738e...`](https://stellar.expert/explorer/testnet/tx/d5e1bd52738e70076027b9d853a586dc82b12e92d3b6f7a66aa58552d65edac8). Claim 205.87 EURC: [`1561e7836777...`](https://stellar.expert/explorer/testnet/tx/1561e7836777d73fd5e0fef3beee0841266ac4c1599fb12dd7defb27ecd95013). |
| A denied action is a readable failure, not a hang. | The investor subscribes 3 notes (300 EURC). The checker does not vote above 250 EURC. A person rejects the approval `ap-01k85-od24k-ep1ag7th00161ber` in the Dfns dashboard. The front then shows "Your policy approver denied this action: blocked by policy" ([screenshot](evidence/deal-c/policy-denied-front.jpg)). The `signing_request` row has the status `rejected` and the reason `blocked by policy`. Horizon answers 404 for the hash of the prepared transaction (`6f175db5359293a7...`): this transaction does not exist. |
| An action above the threshold completes after a second approval. | The investor subscribes 5 notes (500 EURC). A person approves `ap-01k85-ognh5-efvr2lhlv5fs63ms`. Transaction: [`0f83b44cb92b...`](https://stellar.expert/explorer/testnet/tx/0f83b44cb92bb701f657b440306d78463da3658ce4a4c62851d25809fc8d7667). |
| A payment date runs through the custodied operator keys. | The reporter wallet pushes EURIBOR 1M at 2.484 % (fixing of 2026-11-20): [`faf9ce1f2e93...`](https://stellar.expert/explorer/testnet/tx/faf9ce1f2e9323ee1268bc20cc7a13654df898558d0ebfc22e9184872c029e6b). The servicer wallet calls `distribute` for period 1: [`32010a285df5...`](https://stellar.expert/explorer/testnet/tx/32010a285df5cb4b63d660f0f209f3c49c523194de876100ecd1f8b9843dbe23). A person approves each of these two signatures. The crank wallet then pushes the three classes. Step 19 found no raw secret: the two `grep` commands print nothing and 0, and the 15 tests of `test/custody.test.ts` pass. |
| The policy wallet signs a classic ChangeTrust. | The investor wallet adds its EURC trustline ([`5f628e5fc2b6...`](https://stellar.expert/explorer/testnet/tx/5f628e5fc2b639f30c0e402703cd3e04ead23a0bae1adaaac20609e02a7e2431)), removes it ([`18bbfac7bcee...`](https://stellar.expert/explorer/testnet/tx/18bbfac7bcee1086d683bf807ac17aa5a2c713da1348382b8b5f62bf80cf72b3)) and adds it again ([`8b35ee435473...`](https://stellar.expert/explorer/testnet/tx/8b35ee4354737eb287afad19341db99da3d8d7d5d20087dc226704cc8c51cbc5)). The servicer wallet also adds its trustline: [`15439d295386...`](https://stellar.expert/explorer/testnet/tx/15439d2953866f63f3b366b9ebd306fbae666f7ae94188cddd6c2fbd70b2ae10). |
| The self-custody path is unchanged. | The Freighter wallet adds its trustline ([`fd455520028e...`](https://stellar.expert/explorer/testnet/tx/fd455520028eb7cee148ad87d2093430a15b4953e5da7e94c0faeecab726f7d6)), subscribes 1 Class B note ([`1c83e4f0c571...`](https://stellar.expert/explorer/testnet/tx/1c83e4f0c571cd3a967bc530841f1cbcb4834d24e166eb8302cfe62af86977a3)) and cancels it ([`5ad50b7a5807...`](https://stellar.expert/explorer/testnet/tx/5ad50b7a580725f72ae96276277124f782f8f405763183916d775c1b0b711d2b)). |

The investor removed its trustline before the payment date. The push of
Class A could not pay this holder
([`a989bb25bcdd...`](https://stellar.expert/explorer/testnet/tx/a989bb25bcdd095ea7e1f0df7279d163ef0aec2d0c19c15cddf4c58eb6bfe41a)),
so its 205.87 EURC waited in the paying agent until the claim.

### Approvals

The checker approved each investor request at or below 250 EURC. A person
decided each other request in the Dfns dashboard. The crank wallet has no
policy: its 5 deploy transactions and its 3 pushes needed no approval.

| Approval | Wallet | Request | Decision | Transaction |
|---|---|---|---|---|
| `ap-01k85-n548b-etu8vvh652o54usj` | servicer | ChangeTrust EURC | a person approves | [`15439d295386...`](https://stellar.expert/explorer/testnet/tx/15439d2953866f63f3b366b9ebd306fbae666f7ae94188cddd6c2fbd70b2ae10) |
| `ap-01k85-o4fo5-etd95if69mrg8qcp` | admin | `set_wiring` | a person approves | [`d76c76e14e01...`](https://stellar.expert/explorer/testnet/tx/d76c76e14e01b353d9938e4f0ebc90764526046d3f47f74d905321a13d388d45) |
| `ap-01k85-o6aku-em3b3ra3d8hpejl1` | admin | `set_eligible`, 3 addresses | a person approves | [`f3904b8a3554...`](https://stellar.expert/explorer/testnet/tx/f3904b8a3554a1b432df9e751ee39aa3c34fd48461b3799adc34f66232d92d6a) |
| `ap-01k85-oajhc-e1c81vf3te8kn4jt` | investor | ChangeTrust EURC | the checker approves | [`5f628e5fc2b6...`](https://stellar.expert/explorer/testnet/tx/5f628e5fc2b639f30c0e402703cd3e04ead23a0bae1adaaac20609e02a7e2431) |
| `ap-01k85-oc7uv-eqepvnronpd5emee` | investor | subscribe 2 notes, 200 EURC | the checker approves | [`5edaab51eb1d...`](https://stellar.expert/explorer/testnet/tx/5edaab51eb1d20e92afc08fac2e36c7a1647f655ebe2ff4d04da1c059792e91c) |
| `ap-01k85-od24k-ep1ag7th00161ber` | investor | subscribe 3 notes, 300 EURC | a person rejects | none |
| `ap-01k85-ognh5-efvr2lhlv5fs63ms` | investor | subscribe 5 notes, 500 EURC | a person approves | [`0f83b44cb92b...`](https://stellar.expert/explorer/testnet/tx/0f83b44cb92bb701f657b440306d78463da3658ce4a4c62851d25809fc8d7667) |
| `ap-01k85-ojee5-e37qcdsjsnnaobsd` | investor | cancel 1 note, 100 EURC | the checker approves | [`d5e1bd52738e...`](https://stellar.expert/explorer/testnet/tx/d5e1bd52738e70076027b9d853a586dc82b12e92d3b6f7a66aa58552d65edac8) |
| `ap-01k85-ok7m2-e5spau0p0fo7og3k` | investor | subscribe 1 note, 100 EURC | the checker approves | [`b060179132a5...`](https://stellar.expert/explorer/testnet/tx/b060179132a5db96138faac6b5e9419fb64b491156142c80dea8e8d172e0e87d) |
| `ap-01k85-rn96b-e889mg84brnegab4` | admin | `close` | no decision in 25 minutes: the approval expires | none |
| `ap-01k86-4bpuu-etj8410crsskm200` | admin | `close` | a person approves | [`2513f5c1c8f1...`](https://stellar.expert/explorer/testnet/tx/2513f5c1c8f14abb2e3cce7e63e39e09cbce25829f6d1b488cdec56c80218b68) |
| `ap-01k86-4tou5-endbk80e50pg0ds3` | investor | ChangeTrust EURC, limit 0 | the checker approves | [`18bbfac7bcee...`](https://stellar.expert/explorer/testnet/tx/18bbfac7bcee1086d683bf807ac17aa5a2c713da1348382b8b5f62bf80cf72b3) |
| `ap-01k86-4vb6a-elcpehucuhp7oin3` | reporter | `set_rate`, 2484 units | a person approves | [`faf9ce1f2e93...`](https://stellar.expert/explorer/testnet/tx/faf9ce1f2e9323ee1268bc20cc7a13654df898558d0ebfc22e9184872c029e6b) |
| `ap-01k86-57s7o-e7gqho7j975lr389` | servicer | `distribute`, period 1, 300 EURC of collections | a person approves | [`32010a285df5...`](https://stellar.expert/explorer/testnet/tx/32010a285df5cb4b63d660f0f209f3c49c523194de876100ecd1f8b9843dbe23) |
| `ap-01k86-5ant5-eo5bt3umlc03rggk` | investor | ChangeTrust EURC | the checker approves | [`8b35ee435473...`](https://stellar.expert/explorer/testnet/tx/8b35ee4354737eb287afad19341db99da3d8d7d5d20087dc226704cc8c51cbc5) |
| `ap-01k86-5bf9g-eqnbjsonbav32vvg` | investor | `claim` | the checker approves | [`1561e7836777...`](https://stellar.expert/explorer/testnet/tx/1561e7836777d73fd5e0fef3beee0841266ac4c1599fb12dd7defb27ecd95013) |

[evidence/deal-c/dfns-approvals.json](evidence/deal-c/dfns-approvals.json)
is the export of all the approvals of the Dfns organization, as the Dfns API
returns them (`GET /v2/policy-approvals`). The personal access token of the
checker read them on 2026-11-24, with read requests only. The export holds 18
approvals. The two approvals that are not in the table are the test of the
checker on 2026-11-23 at 18:54 UTC, before the run: one approved subscription
and one denied call.

Each row of the table agrees with the export: the status is the same, and the
decision is by the checker or by a person, as the row says. A decision of the
checker has a reason text. A decision of a person has no reason. Thus the
export shows who decided, although Dfns records both decisions under the name
of the person.

### Setup of the run

The run used the Dfns trial plan. Its setup differs from section 1 on these
points:

- The trial plan allows one policy. One policy covers the investor, admin,
  servicer and reporter wallets (`walletTags.hasAny`), and the crank stays
  outside it. A pending approval expires after 25 minutes for every wallet.
- `serviceAccountsCanApprove` is not enabled for the organization. The
  checker votes with a personal access token of the approver. Dfns then
  records each vote of the checker under the name of this person. The log of
  the checker and the `decision` column of `signing_request` (`auto` or
  `needs_approval`) show who decided.
- One service account serves custody-api and spv-backend.
- Dfns gives the same reason, `blocked by policy`, for a rejected approval and
  for an expired approval.
- The settlement asset is the self-issued test EURC
  `CBEO2RDQKBM7S3TYOYKBWAJEC6WMYPCW6JJWX47UCLFMUJI2EUZPJOXW`.

Before any other use, apply section 1: give the checker its own credentials
with a limited role, give each backend its own service account, use two
policies, and replace the tokens of this run.
