---
name: flash-trading
description: Workflow and safety rails for trading on the Definitive Flash API via the definitive-flash MCP tools. Use whenever the user wants to quote, buy, sell, swap, or manage orders (market, limit, TWAP, stop, take-profit, bracket) on EVM chains or Solana through Flash.
---

# Trading on Definitive Flash

The `definitive-flash` MCP server exposes: `flash_setup`, `flash_status`, `flash_quote`,
`flash_balances`, `flash_submit_order`, `flash_get_order`, `flash_list_orders`,
`flash_cancel_order`.

## Safety rails (non-negotiable)

1. **`flash_submit_order` spends real funds.** Before calling it, show the user a fresh
   `flash_quote` result (price, expected output, price impact, fees) and get their explicit
   confirmation in this conversation. Never submit an order the user hasn't confirmed.
2. **Never ask the user to paste a private key into chat**, and if they try, stop them —
   it would flow through the model and the transcript. Route them to their own terminal:
   ```bash
   npx -y @definitive-fi/flash-mcp set-key evm   # or: svm, api (hidden prompt → Keychain)
   ```
   or environment variables (`DEFINITIVE_PRIVATE_KEY`, `DEFINITIVE_SVM_PRIVATE_KEY`,
   `DEFINITIVE_API_KEY`). The `flash_setup` key parameters exist only as a last-resort fallback.
3. **Don't retry a failed submit blindly.** Read the error, re-quote, and re-confirm —
   a timeout does not mean the order failed; check `flash_get_order` first.
4. **One order at a time.** Never issue parallel `flash_submit_order` calls — wait for each
   to reach a terminal status before submitting the next. For multi-token requests (e.g.
   "sweep everything to USDC"): fetch balances, quote each token, present the full plan for
   one confirmation, then execute sequentially, reporting progress as you go. Skip tokens
   that fail to quote (dust often has no route) and summarize successes and failures at the
   end. (The server also serializes same-wallet orders per chain as a backstop.)

## First-run setup

1. Call `flash_setup` with no arguments. If no API key is stored, it returns a link to
   `app.definitive.fi/account/organization/mcp-setup` — the user logs in, clicks
   **Generate API Key**, and copies it. An API key (`dpka_…`) is safe to accept in chat.
2. Store it: `flash_setup { "apiKey": "dpka_…" }`.
3. For trading, the user adds a funder wallet **from their own terminal** (see safety rail 2).
4. Recommend a custom RPC (public defaults are rate-limited):
   `flash_setup { "rpc": { "base": "https://…" } }`.

`flash_status` shows what's configured and the supported chains at any time.

## Quoting and ordering

- `flash_quote` needs no wallet — use it freely to price trades and answer "what would I get" questions.
- `flash_balances` answers "what do I hold" — never look up RPC endpoints yourself or curl a
  node; it uses the built-in per-chain RPCs. Defaults to the funder wallet. On EVM chains pass
  the ERC-20 addresses you care about; on Solana it lists all SPL holdings by default.
- Check `flash_balances` before submitting an order when there's any doubt the wallet can
  cover the spend plus gas.
- Assets are **addresses**, not symbols. If the user gives a symbol, resolve the address on the
  target chain and confirm it with them before quoting — a wrong address trades the wrong token.
- `qty` is the amount being **spent**: `contraAsset` units for buys, `targetAsset` units for sells.
- Order types: `market`, `limit` (requires `limitNotionalPrice`), `twap` (requires
  `durationSeconds` ≥ 300, optional `twapBucketCount`), `stop` / `stop-loss`, `take-profit`,
  `bracket` (uses `triggers` with USD `notionalPrice` + `upper`/`lower`).
- Market orders poll until terminal status by default (`waitForFill`, `pollTimeoutSec`).
- EVM trades may send a one-time ERC-20 approve (plus a wrap tx for native-asset trades) before
  signing — the wallet needs a little native gas. On Solana, `svmUseNativeSOL: true` wraps SOL.
- Chains: ethereum, optimism, bsc, polygon, base, arbitrum, avalanche, blast, hyperevm, plasma,
  monad, solana.

## Managing orders

- `flash_get_order { orderId }` — status, fills, detail (use after any ambiguous submit).
- `flash_list_orders` — recent orders for the funder wallet; filter with `statuses`, page with `pageSize`.
- `flash_cancel_order { orderId }` — cancel a resting limit/trigger/TWAP order. Confirm with the
  user which order before cancelling if there is any ambiguity.
