# TradeStars Verifier Agent Guide

This repository is a public CLI for checking TradeStars arena proof data and for building user-signed Solana claim/refund transactions.

## What This CLI Does

Use this CLI when a user wants to independently check a completed TradeStars arena, replay an entry, inspect a payout proof, or claim/refund from the Solana program without relying on the app UI.

Read-only verification never needs company secrets. Claiming and refunding require the user's local Solana keypair file and sign locally.

## Common Commands

```bash
pnpm install
pnpm build
pnpm dev verify --arena <arena-id> --base-url https://tradestars.app
pnpm dev replay-entry --entry <entry-id> --base-url https://tradestars.app
pnpm dev claim-proof --arena <arena-id> --wallet <wallet> --base-url https://tradestars.app
```

For dev or preview environments, pass the preview URL explicitly:

```bash
pnpm dev verify --arena <arena-id> --base-url https://<preview-url>
pnpm dev replay-entry --entry <entry-id> --base-url https://<preview-url>
```

For Solana actions:

```bash
pnpm dev claim --arena <arena-id> --keypair ~/.config/solana/id.json --base-url https://tradestars.app --rpc <solana-rpc>
pnpm dev refund --arena <arena-id> --keypair ~/.config/solana/id.json --rpc <solana-rpc>
```

## Public Endpoints Used

- `/api/public/proof-key`
- `/api/public/arenas/:arenaId/proofs`
- `/api/public/arenas/:arenaId/stats-proof`
- `/api/public/arenas/:arenaId/settlement-proof`
- `/api/public/arenas/:arenaId/claim-proof/:wallet`
- `/api/public/entries/:entryId/replay-proof`

## Verification Workflow

1. Run `verify --arena` to check the arena proof signatures and settlement commitments.
2. Run `replay-entry --entry` for the disputed entry.
3. Compare the replay result with the published final rank, score, and payout.
4. If the replay reports a mismatch, report the first failing check and the relevant arena or entry ID.

## Safety Rules

- Do not ask for company secrets; the verifier does not need them.
- Do not paste or upload a user's private key.
- Only use `--keypair` when the user explicitly wants to sign a claim or refund locally.
- Prefer read-only commands first.
- For preview testing, always pass the preview `--base-url` so the CLI does not default to production.
