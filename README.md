# Definitive Flash MCP

An [MCP](https://modelcontextprotocol.io) server that lets traders quote, execute, and manage
trades on the [Definitive Flash API](https://flash.definitive.fi/docs) directly from any MCP
client (Claude Code, Claude Desktop, Cursor, etc.).

Flash routes across 200+ liquidity sources on 12 chains and returns a signable payload. This
server handles the full flow for you: **quote → wrap/approve → sign → submit → poll for fill**,
for both EVM wallets and Solana.

## What it does

| Tool | Purpose |
|------|---------|
| `flash_setup` | Connect your account: get a link to generate a Flash API key, then store the key and your funder wallet(s). |
| `flash_status` | Show what's configured (API key, wallets) and the supported chains. |
| `flash_quote` | Price a trade without executing. No wallet required. |
| `flash_submit_order` | Execute a trade end to end (market, limit, twap, stop, take-profit, bracket). Spends real funds. |
| `flash_get_order` | Status, fills, and detail for one order. |
| `flash_list_orders` | Recent orders for a funder wallet. |
| `flash_cancel_order` | Cancel a resting order. |

## Install

The server is published to npm as
[`@definitive-fi/flash-mcp`](https://www.npmjs.com/package/@definitive-fi/flash-mcp) — no clone
or build needed. Pick your client:

### Claude Code

```bash
claude mcp add definitive-flash -- npx -y @definitive-fi/flash-mcp
```

Or install the plugin, which bundles the server plus a trading-workflow skill:

```
/plugin marketplace add DefinitiveCo/flash-mcp
/plugin install definitive-flash@flash-mcp
```

### Cursor

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=definitive-flash&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBkZWZpbml0aXZlLWZpL2ZsYXNoLW1jcCJdfQ%3D%3D)

Or add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "definitive-flash": {
      "command": "npx",
      "args": ["-y", "@definitive-fi/flash-mcp"]
    }
  }
}
```

### Codex

```bash
codex mcp add definitive-flash -- npx -y @definitive-fi/flash-mcp
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.definitive-flash]
command = "npx"
args = ["-y", "@definitive-fi/flash-mcp"]
```

### Claude Desktop / other clients

Add the same stdio server to the client's config JSON:

```json
{
  "mcpServers": {
    "definitive-flash": {
      "command": "npx",
      "args": ["-y", "@definitive-fi/flash-mcp"]
    }
  }
}
```

### From source (development)

```bash
cd flash-mcp
bun install      # or: npm install
bun run build    # compiles to dist/
claude mcp add definitive-flash -- node "$PWD/dist/index.js"
```

## Secure credential entry (recommended)

**Never paste a wallet private key into the chat** — it would pass through the model and the
conversation transcript. Instead, store secrets from your own terminal via the built-in CLI. The
key is typed into a hidden prompt (no echo) and written straight to the Keychain:

```bash
flash-mcp set-key evm     # or: svm, api   (prompts hidden, stores in Keychain)
flash-mcp set-key api
flash-mcp set-rpc base https://your-rpc
flash-mcp set-org 5VYFCW7M
flash-mcp status          # show what's configured
flash-mcp remove-key evm
```

If it isn't on your PATH, run it via npx: `npx -y @definitive-fi/flash-mcp set-key evm`.

## First-run setup

1. Run the `flash_setup` tool with no arguments. It links you to the Definitive MCP setup page
   (`app.definitive.fi/account/organization/mcp-setup`) — log in if prompted, click
   **Generate API Key** (or copy your existing Flash key), then **Copy & Close**.
2. Run `flash_setup` again with the key: `{ "apiKey": "dpka_…" }`.
3. Add a funder wallet to trade: `{ "evmPrivateKey": "0x…" }` and/or `{ "svmPrivateKey": "…" }`.
4. (Recommended) Set a custom RPC — the public defaults are rate-limited:
   `{ "rpc": { "base": "https://…" } }`. Pass an empty string to clear one.

That's it — `flash_quote` to price, `flash_submit_order` to trade.

## Credential storage

Secrets are stored in the **macOS Keychain** (service `definitive-flash-mcp`), encrypted at rest
by the OS — never written to a dotfile in plaintext. On non-macOS hosts, or to inject credentials
without calling `flash_setup`, set environment variables (these take precedence over the Keychain):

```
DEFINITIVE_API_KEY            your Flash API key
DEFINITIVE_PRIVATE_KEY        EVM funder wallet private key (0x hex)
DEFINITIVE_SVM_PRIVATE_KEY    Solana funder wallet secret (base58 or JSON byte array)
```

RPC endpoints default to public nodes per chain (rate-limited). Set your own the easy way via
`flash_setup` with `{ "rpc": { "base": "https://…" } }` — persisted to
`~/.config/definitive-flash-mcp/config.json` (non-secret, hand-editable). Precedence, highest
first: per-call `rpcUrl` argument → `DEFINITIVE_RPC_<CHAIN>` env var → `flash_setup` config →
public default.

## Notes

- **`flash_submit_order` spends real funds.** It quotes fresh, signs with your stored key, and
  submits. For market orders it polls until the order reaches a terminal status.
- EVM trades may send a one-time ERC-20 approve (and a wrap tx for native-asset trades) before
  signing — your wallet needs a little gas for those.
- `qty` is the amount being **spent**: in `contraAsset` units for buys, `targetAsset` units for sells.
- Supported chains: ethereum, optimism, bsc, polygon, base, arbitrum, avalanche, blast, hyperevm,
  plasma, monad, solana.
