# Cara7 on Stellar

Tokenization of an auto-lease ABS on Stellar. Deal documents (offering
circulars, prospectuses) feed a document knowledge base. The deal itself is
tranched on-chain through Soroban contracts, and the notes are subscribable
from a DeFi front. The SPV backend renders the CARA7 "Data Spec Book" diagram
as modular, clickable code.

## The six apps

| App | Role | Port |
|---|---|---|
| `apps/docs-api` | Document knowledge base API (Fastify, Prisma, PostgreSQL full-text search) | 3333 |
| `apps/docs-web` | Document drop front, static, served by docs-api locally | 3333 |
| `apps/tranching-api` | On-chain indexer and deal/tranche registry | 8080 |
| `apps/defi-web` | TrueABS DeFi front (Next.js): subscribe and follow a tranche with a self-custody wallet (Stellar Wallets Kit) or a Dfns policy wallet | 3001 |
| `apps/spv-backend` | Data Spec Book backend: clickable map, 20-EV asset pool, 61 NFTs with IPFS CIDs, waterfall bridge, MCP server. Operator transactions are signed by Dfns policy wallets | 8090 |
| `apps/custody-api` | Investor custody service: passkey login, one Dfns policy wallet per investor, signature requests, and the checker that votes on approvals | 8091 |

`contracts/` holds the five Soroban crates: the note token of each class, the
deal contract with its escrow and its waterfall, the paying agent, the rate
oracle and the asset NFT registry. They all run on testnet; the ids are in
[contracts/README.md](contracts/README.md).

One contract binary serves every deal. A configuration file sets the class
count (1 to 8), the note denomination, the rounding unit, the settlement asset
(Circle EURC or SG-FORGE EURCV), the investor whitelist and the waterfall: the
fee lines, the reserve, the triggers and the order of the ranks.

- [WATERFALL.md](WATERFALL.md) describes the rank engine and the role
  separation.
- [SETTLEMENT.md](SETTLEMENT.md) gives the testnet runbook of a deal that
  differs from the reference deal on all these points.
- [CUSTODY.md](CUSTODY.md) gives the Dfns custody setup, its testnet runbook
  and the recorded run of deal C.
- [evidence/](evidence/README.md) holds the recorded testnet runs.

## Getting started

```sh
createdb cara7_kb cara7_tranching cara7_custody              # local PostgreSQL
cp apps/docs-api/.env.example apps/docs-api/.env
cp apps/tranching-api/.env.example apps/tranching-api/.env   # adjust DATABASE_URL
cp apps/custody-api/.env.example apps/custody-api/.env       # adjust DATABASE_URL, add the Dfns values
make setup                                                   # install + migrations
make dev-docs                                                # then dev-tranching, dev-defi, dev-spv, dev-custody
```

Each app runs in its own terminal:

- Documents front: http://localhost:3333 - drop, search, read.
- Tranche marketplace: http://localhost:3001 - live testnet data, wallet
  connection, subscription signed by the wallet.
- Data Spec Book map: http://localhost:8090 - every box of the diagram links to
  the code that implements it.

## Custody

Two signing paths exist side by side. A self-custody investor signs in the
browser wallet. An institutional investor uses a Dfns policy wallet: the
custody service asks Dfns for each signature, and Dfns policies decide whether
it needs an approval. The operator roles (admin, servicer, oracle reporter)
also sign through Dfns policy wallets, so the backend holds no Stellar secret.
[CUSTODY.md](CUSTODY.md) gives the Dfns setup and the testnet runbook.

Dfns signs transactions only. It does not index Soroban events: the
tranching-api indexer reads them with Soroban RPC `getEvents`.

## Verify

```sh
make check              # typecheck, tests and map check for the five TS apps
make contracts-test     # Rust tests of the Soroban contracts (cargo required)
```

## Deployment

- `docs-api` and `tranching-api` run on Railway. The start command is
  `npm --prefix apps/$START_TARGET run start:prod`, because pnpm is absent from
  the runtime. Both share one PostgreSQL instance; the tranching service uses
  its own schema, passed explicitly to the pg adapter, since `?schema=` is only
  read by the migration CLI.
- `docs-web` and `defi-web` are static deploys on Vercel.
- `spv-backend` runs from a checkout for now. Its waterfall, oracle and mint
  calls sign through the Dfns operator wallets, and a person approves each
  admin, servicer and reporter signature in the Dfns dashboard.
- `custody-api` runs like the other APIs, with its own schema. Run its checker
  (`pnpm --filter custody-api checker`) as a separate process with its own Dfns
  credentials.
