# TradeStars Verifier

Small public CLI for checking TradeStars arena proofs and claiming settled
winnings directly from the Solana program.

The CLI needs no company secrets. Verification is read-only. Claiming or
refunds require a user-supplied Solana keypair file and sign locally.

## Install

```bash
pnpm install
pnpm build
```

## Commands

```bash
pnpm dev verify --arena <arena-id> --base-url http://localhost:3000

pnpm dev claim-proof \
  --arena <arena-id> \
  --wallet <solana-wallet> \
  --base-url http://localhost:3000

pnpm dev replay-entry \
  --entry <entry-id> \
  --base-url http://localhost:3000

pnpm dev claim \
  --arena <arena-id> \
  --keypair ~/.config/solana/id.json \
  --base-url http://localhost:3000 \
  --rpc https://api.devnet.solana.com

pnpm dev refund \
  --arena <arena-id> \
  --keypair ~/.config/solana/id.json \
  --rpc https://api.devnet.solana.com
```

## Environment

Optional defaults:

```bash
TRADESTARS_BASE_URL=tradestars.app
SOLANA_RPC=https://api.devnet.solana.com
TRADESTARS_PROGRAM_ID=2YEsWGLfhsUwDWoFCEZQQeES8KN9jHHRXLkbtwoDQGV8
```

If `TRADESTARS_BASE_URL` is not set, the CLI uses `tradestars.app` and adds
`https://` automatically. `SOLANA_RPC` controls the Solana RPC endpoint.

`claim` fetches the wallet-specific Merkle branch from:

```text
/api/public/arenas/:arenaId/claim-proof/:wallet
```

Then it builds a `claim_winnings(locked_amount, payout_amount, proof)`
instruction with the user wallet marked as the signer. For the `claim` command,
the CLI reads the local JSON keypair passed with `--keypair`, verifies that the
returned claim proof belongs to that wallet, and signs the transaction locally
with `sendAndConfirmTransaction`. The private key is not sent to the TradeStars
API or the Solana RPC endpoint, but it is loaded into this local process. Run
`claim` and `refund` only from a trusted machine with a keypair file you are
comfortable using in a CLI process.

`replay-entry` fetches the public post-arena replay bundle and the arena's live
commitment log. It verifies:

- every entry timeline event hash
- every event's `previousEntryHash`
- every score application arithmetic step
- every replay event was committed in the live public commitment log
- the claim proof reconstructs the published payout Merkle root, when present
