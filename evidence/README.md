# Testnet evidence

This folder holds the recorded testnet runs of Tranche 1. Each address in it
is a public testnet address. The folder holds no key.

| Path | Content |
|---|---|
| `wasm/` | The deployed contract files and their SHA-256 (`SHA256SUMS`). |
| `deal-p/` | Deal P: pro rata principal, then sequential after a trigger (D1). |
| `deal-s/` | Deal S: sequential principal on Circle EURC, full lifecycle (D1 and D2). |
| `deal-c/` | Deal C: Dfns policy wallets for the investor and the operator roles (D3). |

Each deal folder has four files:

| File | Content |
|---|---|
| `deal.json` | The deal file that the deploy tool read. |
| `deploy.json` | The contract ids, the code hashes and the deploy transactions. |
| `events.json` | The raw evidence: the contract events and the state of the deal. |
| `evidence.md` | The report: each transaction, each payment date, each holder and each check. |

`deal-c/` also holds two files:

| File | Content |
|---|---|
| `policy-denied-front.jpg` | The front after a person rejects a request. |
| `dfns-approvals.json` | The export of the 18 Dfns approvals of the organization, as the Dfns API returns them. |

[CUSTODY.md](../CUSTODY.md#evidence) connects the six points of D3 to their
transactions and their Dfns approvals.

## Check the evidence

Compare the wasm files with their checksums:

```sh
cd evidence/wasm && shasum -a 256 -c SHA256SUMS
```

Compare a deployed contract with these files:

```sh
stellar contract fetch --id <contract> --network testnet --out-file code.wasm
shasum -a 256 code.wasm
```

Run the checks again from a bundle, with no network. The report is then
identical to `evidence.md`:

```sh
cd apps/spv-backend
pnpm deal:evidence --from-bundle ../../evidence/deal-s/events.json --out report.md
```

Soroban RPC keeps the events for about 7 days. The bundle keeps them after
this time, and after a reset of the testnet.
