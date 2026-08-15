# Investors lane

The INVESTORS lane of the Data Spec Book is not re-implemented here - it is
already live elsewhere in the monorepo:

| Diagram box | Implementation | Live |
|---|---|---|
| Tranches Class A / B / C (note certificates) | `contracts/note-token` (SEP-41 ABS notes, decimals 0, fixed original face, MERKL day-weight ledger) | Stellar testnet - contract ids in `contracts/README.md` |
| Waterfall + funding escrow | `contracts/abs-deal` (subscribe/cancel, closing DvP, waterfall v4) | Stellar testnet |
| Paying Agent Interest & Principal + Interest service MERKL | `contracts/paying-agent` (per-holder pushes, claim fallback, counters) | Stellar testnet |
| Tranche registry & indexer | `apps/tranching-api` (deals, notes, distributions by period, holder registry) | https://tranching-production.up.railway.app |
| Investor dashboard | `apps/defi-web` (Next.js marketplace, note factor/outstanding tiles, distribution history) | https://trueabs-marketplace.vercel.app |
| Investor wallets | Freighter via Stellar Wallets Kit v2, wired in `apps/defi-web` | browser extension |

## Flow

1. An investor connects Freighter on the marketplace and needs a trustline to
   the demo EURC (issuer `GCB6FLVH...`, see `contracts/README.md`).
2. During the FUNDING window, `subscribe(investor, class, notes)` on the deal
   contract escrows EURC at par (100 EURC per note); `cancel` refunds any
   time before closing - the only exit that ever exists.
3. At CLOSING (`POST /waterfall/close-deal` from this backend) the proceeds
   pay the Seller for the receivables, the reserve is funded, and the notes
   are issued. From here there is NO deposit and NO withdraw.
4. Each period (`POST /waterfall/run-period`) the waterfall pays every
   class's interest AND principal to the paying agent contract, which pushes
   EURC to each noteholder's wallet - the money simply arrives; failed
   pushes stay claimable (`claim`). Notes remain transferable; a mid-period
   sale splits the next coupon day-weighted between seller and buyer.
5. The dashboard reads tranching-api for note factors, outstanding nominals,
   received interest/principal counters, distribution history and the
   next-payment countdown (3-day periods).
