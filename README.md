# TradeStars Verifier

Small public CLI for checking TradeStars arena proofs and claiming settled
winnings directly from the Solana program.

The CLI needs no company secrets. Verification is read-only. Claiming or
refunds require the user's Solana keypair.

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
TRADESTARS_BASE_URL=http://localhost:3000
TRADESTARS_SOLANA_RPC=https://api.devnet.solana.com
TRADESTARS_PROGRAM_ID=2YEsWGLfhsUwDWoFCEZQQeES8KN9jHHRXLkbtwoDQGV8
```

`claim` fetches the wallet-specific Merkle branch from:

```text
/api/public/arenas/:arenaId/claim-proof/:wallet
```

Then it calls `claim_winnings(locked_amount, payout_amount, proof)` with the
user wallet as signer.

`replay-entry` fetches the public post-arena replay bundle and the arena's live
commitment log. It verifies:

- every entry timeline event hash
- every event's `previousEntryHash`
- every score application arithmetic step
- every replay event was committed in the live public commitment log
- the claim proof reconstructs the published payout Merkle root, when present
