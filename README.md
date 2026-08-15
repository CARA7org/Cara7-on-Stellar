# Cara7 on Stellar

Tokenization of an auto-lease ABS on Stellar. Deal documents (offering
circulars, prospectuses) feed a document knowledge base. The deal itself is
tranched on-chain through Soroban contracts, and the notes are subscribable
from a DeFi front. The SPV backend renders the CARA7 "Data Spec Book" diagram
as modular, clickable code.

## The five apps

| App | Role | Port |
|---|---|---|
| `apps/docs-api` | Document knowledge base API (Fastify, Prisma, PostgreSQL full-text search) | 3333 |
| `apps/docs-web` | Document drop front, static, served by docs-api locally | 3333 |
| `apps/tranching-api` | On-chain indexer and deal/tranche registry | 8080 |
| `apps/defi-web` | TrueABS DeFi front (Next.js, Stellar Wallets Kit): subscribe and follow a tranche | 3001 |
| `apps/spv-backend` | Data Spec Book backend: clickable map, 20-EV asset pool, 61 NFTs with IPFS CIDs, waterfall bridge, MCP server | 8090 |

`contracts/` holds the five Soroban crates: the note token of each class, the
deal contract with its escrow and its waterfall, the paying agent, the rate
oracle and the asset NFT registry. They all run on testnet; the ids are in
[contracts/README.md](contracts/README.md).

## Getting started

```sh
createdb cara7_kb cara7_tranching                            # local PostgreSQL
cp apps/docs-api/.env.example apps/docs-api/.env
cp apps/tranching-api/.env.example apps/tranching-api/.env   # adjust DATABASE_URL
make setup                                                   # install + migrations
make dev-docs                                                # then dev-tranching, dev-defi, dev-spv
```

Each app runs in its own terminal:

- Documents front: http://localhost:3333 - drop, search, read.
- Tranche marketplace: http://localhost:3001 - live testnet data, wallet
  connection, subscription signed by the wallet.
- Data Spec Book map: http://localhost:8090 - every box of the diagram links to
  the code that implements it.

## Verify

```sh
make check              # typecheck, tests and map check for the four TS apps
make contracts-test     # Rust tests of the Soroban contracts (cargo required)
```

## Deployment

- `docs-api` and `tranching-api` run on Railway. The start command is
  `npm --prefix apps/$START_TARGET run start:prod`, because pnpm is absent from
  the runtime. Both share one PostgreSQL instance; the tranching service uses
  its own schema, passed explicitly to the pg adapter, since `?schema=` is only
  read by the migration CLI.
- `docs-web` and `defi-web` are static deploys on Vercel.
- `spv-backend` runs from a checkout for now: the map, the mint and the
  waterfall calls all need the operator's keys.
