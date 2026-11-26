# custody-api

custody-api is the investor custody service of CARA7. It gives each investor
one org-managed Dfns wallet with the tag `cara7:investor`. The investor logs in
with a passkey (WebAuthn). The service then starts the Dfns signature requests
for that wallet.

The service signs nothing itself and keeps no key material. Dfns signs. The
front submits the signed transaction with its own Soroban RPC. The self-custody
path (Stellar Wallets Kit) does not use this service.

## Trust model

- The initiator service account (server, `DFNS_*`) can only start a signature
  request. The guard refuses every call outside the allowlist before Dfns.
- The Dfns policy on `cara7:investor` wallets holds every signature request for
  an approval. The approval group is the checker and one person, quorum 1.
- The checker service account (`pnpm checker`, `CHECKER_DFNS_*`) decodes each
  request and votes. It approves an allowlisted call at or below the threshold
  and denies all other calls.
- Above the threshold, the checker does not vote. A person approves or rejects
  the subscribe in the Dfns dashboard.
- The checker must run on separate credentials and on a separate host. One
  stolen key must not be enough to sign a transaction.

## Policy

`src/policy/testnet.json` is the allowlist. It contains public ids only. The
guard and the checker both apply `evaluateRequest` (`src/policy/evaluate.ts`).
The rules run in this order. The first rule that fails gives `deny`.

1. A plain transaction envelope (not a fee bump) for the policy network.
2. The transaction source is the investor wallet.
3. One operation. Its source is absent or the investor wallet.
4. The fee is at or below `maxFeeStroops`.
5. `maxTime` is set and at or below now + `maxValiditySeconds`.
6. The operation is one of these:
   - `subscribe` or `cancel (investor, class, notes)` on a listed deal
     contract, with `investor` equal to the wallet and `notes` above 0.
   - `claim (holder)` on a listed paying agent, with `holder` equal to the
     wallet.
   - `changeTrust` on the policy EURC asset, with any limit (0 removes the
     trustline).

A contract call must use source-account credentials only, and the root
invocation of each auth entry must be the same call. A `subscribe` above
`thresholdEurc` gives `abstain`. All amounts are BigInt base units.

## Routes

Every route except `/health` and `/auth/*` needs `Authorization: Bearer <sessionToken>`.
Every 4xx and 5xx answer has the body `{ "error": "<readable sentence>", "code": "<code>" }`.

| Route | Body | Response |
| - | - | - |
| `GET /health` | - | `{ ok: true }` |
| `POST /auth/register/options` | `{ displayName }` (1 to 64 characters) | `{ challengeId, options }` |
| `POST /auth/register/verify` | `{ challengeId, response }` | `{ sessionToken, expiresAt, investor }` |
| `POST /auth/login/options` | `{}` | `{ challengeId, options }` (discoverable credentials) |
| `POST /auth/login/verify` | `{ challengeId, response }` | `{ sessionToken, expiresAt, investor }` |
| `POST /auth/logout` | - | 204 |
| `GET /me` | - | `{ investor }` |
| `POST /sign` | `{ transactionXdr, networkPassphrase }` | `SignResult` |
| `GET /sign/:requestId` | - | `SignResult` (refreshed from Dfns) |

The shapes of `investor` and `SignResult` are in `src/types.ts`.

| Code | HTTP | When |
| - | - | - |
| `bad_request` | 400 | The body is not valid, or the XDR cannot be decoded. |
| `unauthorized` | 401 | No session, an expired session, or a passkey that does not verify. |
| `not_found` | 404 | An unknown route, or a signature request of another investor. |
| `expired` | 410 | The passkey challenge expired (5 minutes) or was already used. |
| `pending_exists` | 409 | An earlier request of this investor still waits for approval. |
| `not_allowed` | 422 | The policy guard denies the transaction. `error` gives the reason. |
| `custody_unavailable` | 502 | Dfns or Friendbot did not answer correctly. |
| `internal_error` | 500 | An unexpected error. |

Registration creates the Dfns wallet, stores the investor and the passkey, then
funds the wallet with Friendbot on testnet. When Friendbot fails, the investor
exists and can log in, but the wallet has no XLM yet.

When Dfns returns `Signed`, the service decodes `signedData` and compares its
hash with the hash of the prepared transaction. It also checks the wallet
signature. A different hash gives `failed` with the reason "The custody
provider returned a different transaction."

## Environment

`.env.example` lists every variable. Do not put the checker variables on the
server host, and do not put the initiator variables on the checker host.

| Variable | Process | Default |
| - | - | - |
| `STELLAR_NETWORK` | both | `testnet` |
| `DFNS_API_URL` | both | `https://api.dfns.io` |
| `DFNS_ORG_ID` | both | required |
| `PORT`, `HOST` | server | `8091`, `127.0.0.1` |
| `DATABASE_URL` | server | required, schema `custody` |
| `CORS_ORIGIN` | server | `http://localhost:3001` |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGIN` | server | `localhost`, `CARA7`, `http://localhost:3001` |
| `SESSION_TTL_HOURS` | server | `12` |
| `SOROBAN_RPC_URL`, `HORIZON_URL` | server | testnet endpoints |
| `FRIENDBOT_URL` | server (testnet) | `https://friendbot.stellar.org` |
| `DFNS_AUTH_TOKEN`, `DFNS_CRED_ID`, `DFNS_PRIVATE_KEY` | server | required (initiator) |
| `CHECKER_DFNS_AUTH_TOKEN`, `CHECKER_DFNS_CRED_ID`, `CHECKER_DFNS_PRIVATE_KEY` | checker | required (checker) |
| `CHECKER_INTERVAL_SECONDS` | checker | `5` |

## Dfns setup

1. Create two service accounts: the initiator and the checker.
2. Give the initiator `Wallets:Create`, `Wallets:Tags:Add`, `Wallets:Read`,
   `Keys:Signatures:Create` and `Keys:Signatures:Read`. If Dfns refuses the
   wallet creation, add `Keys:Create`. Give it no approval permission.
3. Give the checker `Wallets:Read`, `Policies:Evaluations:Read` and
   `Policies:Evaluations:Vote`. (`Policies:Approvals:Approve` is a deprecated
   alias of the vote permission.) Ask Dfns support to enable
   `serviceAccountsCanApprove`.
4. Create the policy: activity `Wallets:Sign`, filter on the tag
   `cara7:investor`, rule `AlwaysTrigger`, action `RequestApproval`. Use one
   approval group with the checker and the person, quorum 1. Set
   `autoRejectTimeout` to 25 minutes, below the 30-minute time bound that the
   front puts on a custody transaction.

## Run

```sh
pnpm install                                   # runs prisma generate
pnpm --filter custody-api db:migrate           # local database, schema custody
pnpm --filter custody-api dev                  # server on http://127.0.0.1:8091
pnpm --filter custody-api checker              # checker, on its own host in production
pnpm --filter custody-api check                # typecheck and offline tests
```

In production, the server starts with `pnpm --filter custody-api start:prod`.
It applies the migrations, then starts. Run one server instance: the "one
pending request per investor" lock is in the process.
