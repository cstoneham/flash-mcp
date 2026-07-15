# Demo runbook — sweep a Robinhood Chain wallet into USDG

Goal: record a Claude Code session where the `definitive-flash` MCP plugin sweeps every
token in a wallet on Robinhood Chain (chain id 4663) into the chain's canonical stable.

## Chain facts (verified 2026-07-15)

- Flash API supports `robinhood` (chain id 4663, RPC `https://rpc.mainnet.chain.robinhood.com`).
- **There is no canonical Circle USDC on Robinhood Chain.** Every "USDC" on the explorer is an
  18-decimal fake with tens of holders. The canonical stable is **USDG (Global Dollar)**:
  `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals) — listed in Robinhood's own
  token-contracts docs. Sweep into USDG, not "USDC".
- WETH: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`.
- Explorer: https://robinhoodchain.blockscout.com (also robinscan.io).

## One-time setup (before recording)

1. **API key** — open https://app.definitive.fi/account/organization/mcp-setup, click
   **Generate API Key**, then store it from your terminal:
   `node dist/index.js set-key api` (hidden prompt → Keychain).
2. **Funder wallet** — store the Robinhood-chain wallet's private key the same way:
   `node dist/index.js set-key evm`. Never paste it into chat.
3. The local build is already registered user-scope
   (`claude mcp add definitive-flash -- node …/flash-mcp/dist/index.js`). Note this repo's
   project config has `definitive-flash` in `disabledMcpServers` — record the demo from a
   different directory, or re-enable it here first.
4. Gas check: the wallet needs a little native ETH on Robinhood Chain for one-time ERC-20
   approves.
5. Smoke test in the demo session before recording:
   - `flash_status` → API key + EVM wallet shown, `robinhood` in supported chains.
   - `flash_quote` a small token→USDG pair on robinhood to confirm Flash routes it.

## Suggested recording script

1. "What's in my wallet on robinhood chain?" → `flash_balances` (pass the token addresses).
2. "Sweep everything into USDG." → skill kicks in: quote each token, present the full plan,
   one confirmation, then sequential `flash_submit_order` sells with progress.
3. "Show my orders." → `flash_list_orders` for the wrap-up shot.

## Publishing note

Robinhood support ships in 0.1.6 — make sure that version is published to npm before
demoing via `npx -y @definitive-fi/flash-mcp` (the local build works regardless).
