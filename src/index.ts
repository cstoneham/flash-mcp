#!/usr/bin/env node
// Definitive Flash MCP server — lets a trader quote, trade, and manage orders on
// the Flash API directly from an MCP client. stdio transport.

import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fetchBalances } from "./balances.js";
import { CHAIN_IDS, getChain, usingDefaultRpc } from "./chains.js";
import { CONFIG_FILE_PATH, getConfig, setOrganization, setRpcOverrides } from "./config.js";
import {
  funderAddressFor,
  requireClient,
  requirePrivateKey,
  resolveClient,
  SetupError,
} from "./context.js";
import { credentialSource, getCredential, maskSecret, setCredential } from "./credentials.js";
import { FlashApiError } from "./flashClient.js";
import { orderDetail, orderLine, quoteSummary, result } from "./format.js";
import { cancelOrder, placeOrder } from "./orderFlow.js";
import { MCP_SETUP_URL, runCli } from "./cli.js";
import type { FlashOrderStatus, OrderSide, OrderType, PriceTrigger } from "./types.js";

// The interactive out-of-band wizard users run in their own terminal. Handles
// API key, funder wallets, and RPCs; secrets never pass through the chat.
const WIZARD_CMD = "npx -y @definitive-fi/flash-mcp setup";

// ----- shared zod fragments for trade params -----
const chainEnum = z.enum(CHAIN_IDS as [string, ...string[]]);
const sideEnum = z.enum(["buy", "sell"]);
const orderTypeEnum = z.enum(["market", "limit", "twap", "stop", "stop-loss", "take-profit", "bracket"]);
const triggerSchema = z.object({
  notionalPrice: z.string().describe("USD trigger price on the target asset"),
  triggerType: z.enum(["upper", "lower"]),
});

const tradeShape = {
  targetChain: chainEnum.describe("Chain of the target (traded) asset"),
  contraChain: chainEnum.describe("Chain of the contra asset (usually same as targetChain)"),
  targetAsset: z.string().describe("Address of the target (traded) asset"),
  contraAsset: z.string().describe("Address of the contra asset — spent on buys, received on sells"),
  side: sideEnum,
  qty: z
    .string()
    .describe("Decimal amount being spent: contraAsset units for buys, targetAsset units for sells"),
  orderType: orderTypeEnum.default("market"),
  maxSlippage: z.string().optional().describe("Slippage tolerance as a decimal, e.g. 0.01 = 1% (default 0.05)"),
  maxPriceImpact: z.string().optional().describe("Max price impact as a decimal (default 0.05)"),
  limitNotionalPrice: z.string().optional().describe("USD limit price; required for limit orders"),
  quickTrade: z.boolean().optional().describe("Market-only QuickTrade mode"),
  svmUseNativeSOL: z.boolean().optional().describe("Solana: treat spent wSOL as native SOL and wrap it"),
  flashIntegratorFeeBps: z.string().optional().describe("Integrator fee in bps (max 1000 = 10%)"),
  expireTime: z.string().optional().describe("ISO-8601 expiry for limit/trigger orders (omit for GTC)"),
  durationSeconds: z.number().int().optional().describe("TWAP only: total duration, min 300"),
  twapBucketCount: z.number().int().optional().describe("TWAP only: number of equal-time buckets"),
  triggers: z.array(triggerSchema).max(2).optional().describe("Price triggers for stop/take-profit/bracket"),
};

function tradeRequestFromArgs(a: Record<string, unknown>) {
  return {
    targetChain: a.targetChain as string,
    contraChain: a.contraChain as string,
    targetAsset: a.targetAsset as string,
    contraAsset: a.contraAsset as string,
    side: a.side as OrderSide,
    qty: a.qty as string,
    orderType: (a.orderType as OrderType) ?? "market",
    ...(a.maxSlippage ? { maxSlippage: a.maxSlippage as string } : {}),
    ...(a.maxPriceImpact ? { maxPriceImpact: a.maxPriceImpact as string } : {}),
    ...(a.limitNotionalPrice ? { limitNotionalPrice: a.limitNotionalPrice as string } : {}),
    ...(a.quickTrade !== undefined ? { quickTrade: a.quickTrade as boolean } : {}),
    ...(a.svmUseNativeSOL !== undefined ? { svmUseNativeSOL: a.svmUseNativeSOL as boolean } : {}),
    ...(a.flashIntegratorFeeBps ? { flashIntegratorFeeBps: a.flashIntegratorFeeBps as string } : {}),
    ...(a.expireTime ? { expireTime: a.expireTime as string } : {}),
    ...(a.durationSeconds ? { durationSeconds: a.durationSeconds as number } : {}),
    ...(a.twapBucketCount ? { twapBucketCount: a.twapBucketCount as number } : {}),
    ...(a.triggers ? { triggers: a.triggers as PriceTrigger[] } : {}),
  };
}

const { version: PKG_VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

const server = new McpServer({ name: "definitive-flash", version: PKG_VERSION });

// MCP tool annotations (readOnlyHint / destructiveHint / idempotentHint /
// openWorldHint). Clients use these for permission gating, and the Codex plugin
// directory review rejects tools whose hints don't match real behavior.
interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Register a tool whose handler errors are turned into friendly, non-crashing results. */
function registerTool(
  name: string,
  def: {
    title: string;
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
    annotations: ToolAnnotations;
  },
  fn: (args: any) => Promise<{ content: { type: "text"; text: string }[] }>,
) {
  (server.registerTool as any)(name, def, async (args: any) => {
    try {
      return await fn(args);
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ ${describeError(err)}` }], isError: true };
    }
  });
}

// ---------------------------------------------------------------------------
// flash_setup — connect account / store credentials
// ---------------------------------------------------------------------------
registerTool(
  "flash_setup",
  {
    title: "Set up Flash credentials",
    description:
      "Connect a Definitive account for trading on Flash. The primary setup path is the interactive " +
      "wizard the user runs in their OWN terminal — `" + WIZARD_CMD + "` — which handles the API key, " +
      "funder wallets, and RPCs; direct the user there rather than collecting credentials in chat. " +
      "Call this tool with no arguments to see what's configured and get the exact instructions to " +
      "relay. It also accepts `apiKey` (safe in chat — it cannot move funds) and `rpc` overrides. " +
      "Wallet private keys are NEVER accepted here and must never be pasted into the conversation.",
    // Writes credentials/config locally; never deletes anything and never touches the network.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      apiKey: z.string().optional().describe("Definitive Flash API key (starts with dpka_)"),
      organization: z
        .string()
        .optional()
        .describe(
          "Your Definitive organization slug (optional). Stored for reference; the setup page uses " +
            "whichever organization you're logged into, so this is no longer needed to get an API key.",
        ),
      rpc: z
        .record(chainEnum, z.string())
        .optional()
        .describe(
          "Optional custom RPC URLs per chain, e.g. { \"base\": \"https://…\" }. Recommended — the " +
            "public defaults are rate-limited. Pass an empty string to clear a chain's override.",
        ),
    },
  },
  async (args) => {
    const stored: string[] = [];

    if (args.organization) {
      setOrganization(args.organization as string);
      stored.push(`organization (${args.organization})`);
    }

    if (args.rpc && Object.keys(args.rpc).length > 0) {
      setRpcOverrides(args.rpc as Record<string, string>);
      const set = Object.entries(args.rpc as Record<string, string>)
        .filter(([, u]) => u && u.trim())
        .map(([c]) => c);
      if (set.length) stored.push(`RPC for ${set.join(", ")}`);
    }

    if (args.apiKey) {
      if (!args.apiKey.startsWith("dpka_")) {
        return result("⚠️ That doesn't look like a Flash API key (expected it to start with `dpka_`). Not stored.");
      }
      await setCredential("api-key", args.apiKey);
      stored.push("API key");
    }

    const apiSource = await credentialSource("api-key");
    const evmAddr = await funderAddressFor("base");
    const svmAddr = await funderAddressFor("solana");
    const rpcChains = Object.keys(getConfig().rpc ?? {});

    const lines: string[] = [];
    if (stored.length) lines.push(`✅ Stored: ${stored.join(", ")}.`, "");

    lines.push(
      "**Current configuration**",
      apiSource === "none" ? "- API key: ❌ not set" : `- API key: ✅ configured (source: ${apiSource})`,
      evmAddr ? `- EVM funder wallet: ✅ ${evmAddr}` : "- EVM funder wallet: not set (needed to trade on EVM chains)",
      svmAddr ? `- Solana funder wallet: ✅ ${svmAddr}` : "- Solana funder wallet: not set (needed to trade on Solana)",
      rpcChains.length
        ? `- Custom RPC: ✅ ${rpcChains.join(", ")}`
        : "- Custom RPC: none (using public defaults, which are rate-limited)",
      "",
    );

    const needsKey = apiSource === "none";
    const needsWallet = !evmAddr && !svmAddr;

    if (needsKey || needsWallet) {
      lines.push(
        "**To finish setup, run the interactive wizard in your own terminal** (not through this chat):",
        "```",
        WIZARD_CMD,
        "```",
        "It opens the Definitive API-key page, then walks through the API key, funder wallets, and",
        "RPC endpoints. Secrets are typed into hidden prompts and stored in the macOS Keychain — they",
        "never pass through the model or the conversation transcript. Every step can be skipped and",
        "re-run later. When it finishes, run `flash_status` here to confirm.",
      );
      if (needsKey) {
        lines.push(
          "",
          "_Prefer to stay in chat?_ The API key alone enables quoting and is safe to paste here (it",
          `cannot move funds): open ${MCP_SETUP_URL} , log in, click **Generate API Key**, then`,
          "**Copy & Close**, and paste the `dpka_…` key into the conversation. Funder wallets, however,",
          "can **only** be added from your own terminal — never paste a wallet private key into chat.",
        );
      }
    } else {
      lines.push(
        "🎉 You're fully set up. Try `flash_quote` to price a trade, then `flash_submit_order` to execute.",
        "To change wallets or keys later, run `" + WIZARD_CMD + "` in your terminal.",
      );
    }
    return result(lines.join("\n"));
  },
);

// ---------------------------------------------------------------------------
// flash_status — what's configured
// ---------------------------------------------------------------------------
registerTool(
  "flash_status",
  {
    title: "Flash setup status",
    description: "Show which credentials and wallets are configured, and the supported chains.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {},
  },
  async () => {
    const apiKey = await getCredential("api-key");
    const apiSource = await credentialSource("api-key");
    const evmAddr = await funderAddressFor("base");
    const svmAddr = await funderAddressFor("solana");
    const lines = [
      "**Definitive Flash MCP status**",
      apiKey ? `- API key: ${maskSecret(apiKey)} (source: ${apiSource})` : "- API key: ❌ not set — run `flash_setup`",
      evmAddr ? `- EVM funder wallet: ${evmAddr}` : "- EVM funder wallet: ❌ not set",
      svmAddr ? `- Solana funder wallet: ${svmAddr}` : "- Solana funder wallet: ❌ not set",
    ];
    const rpcCfg = getConfig().rpc ?? {};
    const rpcChains = Object.keys(rpcCfg);
    lines.push(
      rpcChains.length
        ? `- Custom RPC: ${rpcChains.map((c) => `${c}`).join(", ")} (config: ${CONFIG_FILE_PATH})`
        : "- Custom RPC: none (using public defaults; set via `flash_setup`)",
      `- Supported chains: ${CHAIN_IDS.join(", ")}`,
    );
    return result(lines.join("\n"));
  },
);

// ---------------------------------------------------------------------------
// flash_quote — read-only price discovery
// ---------------------------------------------------------------------------
registerTool(
  "flash_quote",
  {
    title: "Get a Flash quote",
    description:
      "Price a trade across 200+ liquidity sources without executing. Returns the spend/receive amounts " +
      "and estimated fees. Does not require a wallet.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: tradeShape,
  },
  async (args) => {
    const { client } = await resolveClient();
    const req = tradeRequestFromArgs(args);
    const funder = await funderAddressFor(req.targetChain);
    const quote = await client.quote({ ...req, ...(funder ? { funderAddress: funder } : {}) });
    return result(quoteSummary(quote), quote);
  },
);

// ---------------------------------------------------------------------------
// flash_balances — read-only wallet balances over the built-in RPCs
// ---------------------------------------------------------------------------
registerTool(
  "flash_balances",
  {
    title: "Get wallet balances",
    description:
      "Fetch native and token balances for a wallet, using the built-in per-chain public RPCs " +
      "(or configured overrides) — no external RPC lookup needed. Defaults to the configured " +
      "funder wallet. Read-only; works without an API key. Omitting `tokens` lists every token " +
      "the wallet holds: SPL tokens on Solana, and ERC-20s on EVM chains that have a block " +
      "explorer configured (auto-discovered, then read live on-chain). Pass explicit `tokens` " +
      "to query specific addresses, or on EVM chains without explorer support (only the native " +
      "balance is returned otherwise).",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      chain: chainEnum,
      address: z
        .string()
        .optional()
        .describe("Wallet address (defaults to the configured funder wallet for this chain)"),
      tokens: z
        .array(z.string())
        .optional()
        .describe("Token addresses (EVM) or mints (Solana) to include"),
      rpcUrl: z.string().optional().describe("Override the RPC endpoint for this call"),
    },
  },
  async (args) => {
    const address = args.address ?? (await funderAddressFor(args.chain));
    if (!address) {
      throw new SetupError(
        `No address given and no funder wallet configured for ${args.chain}. Pass an address, or add a wallet via flash_setup.`,
      );
    }
    const balances = await fetchBalances(args.chain, address, args.tokens, args.rpcUrl);
    // Busy wallets can hold hundreds of (mostly spam) SPL mints; don't flood the
    // conversation — and only append raw JSON when it stays small.
    const MAX_LISTED = 100;
    const shown = balances.slice(0, MAX_LISTED);
    const lines = [
      `**Balances — \`${address}\` on ${args.chain}**`,
      ...shown.map(
        (b) => `- ${b.balance} ${b.symbol}${b.token === "native" ? "" : ` (\`${b.token}\`)`}`,
      ),
    ];
    if (balances.length > shown.length) {
      lines.push(
        `- …and ${balances.length - shown.length} more tokens — pass \`tokens\` to query specific mints`,
      );
    }
    // The built-in public RPCs are heavily rate-limited: token auto-discovery
    // fires many reads at once and they get throttled, so balances can come back
    // incomplete or the call can time out. Tell the user plainly how to fix it.
    if (usingDefaultRpc(args.chain, args.rpcUrl)) {
      const nudge = getChain(args.chain).kind === "evm" && !(args.tokens && args.tokens.length)
        ? "may be incomplete (token auto-discovery is throttled) or time out"
        : "may be rate-limited or time out";
      lines.push(
        "",
        `> ⚠️ Using the public **${args.chain}** RPC. Balances ${nudge}. ` +
          `For complete, reliable results set a custom RPC (e.g. Alchemy/Infura):\n` +
          `> \`flash_setup\` with \`rpc: { "${args.chain}": "https://…" }\`.`,
      );
    }
    return result(lines.join("\n"), balances.length <= 25 ? balances : undefined);
  },
);

// ---------------------------------------------------------------------------
// flash_submit_order — quote, sign, submit (and optionally wait for fill)
// ---------------------------------------------------------------------------
registerTool(
  "flash_submit_order",
  {
    title: "Submit a Flash order",
    description:
      "Execute a trade end to end: fetch a fresh quote, send any required wrap/approve transactions, sign " +
      "the order with your funder wallet, and submit it. For market orders it polls until the order fills " +
      "(or times out). Requires an API key and the matching funder wallet private key. This spends real funds.",
    // Spends real funds and cannot be undone once filled — clients should always confirm with the user.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      ...tradeShape,
      rpcUrl: z.string().optional().describe("Override the RPC used for on-chain wrap/approve sends"),
      waitForFill: z.boolean().optional().describe("Market orders only: poll until filled (default true)"),
      pollTimeoutSec: z.number().int().optional().describe("Max seconds to poll for a fill (default 120)"),
    },
  },
  async (args) => {
    const client = await requireClient();
    const req = tradeRequestFromArgs(args);
    const privateKey = await requirePrivateKey(req.targetChain);
    const res = await placeOrder(client, {
      ...req,
      privateKey,
      ...(args.rpcUrl ? { rpcUrl: args.rpcUrl as string } : {}),
      waitForFill: (args.waitForFill as boolean | undefined) ?? true,
      ...(args.pollTimeoutSec ? { pollTimeoutSec: args.pollTimeoutSec as number } : {}),
    });

    const lines = [
      `**Order submitted: \`${res.orderId}\`**`,
      "",
      ...res.steps.map((s) => `- ${s}`),
    ];
    if (res.finalOrder) {
      lines.push("", orderDetail(res.finalOrder));
    } else {
      lines.push("", `Track it with \`flash_get_order { orderId: "${res.orderId}" }\`.`);
    }
    return result(lines.join("\n"), { orderId: res.orderId, quote: res.quote, finalOrder: res.finalOrder });
  },
);

// ---------------------------------------------------------------------------
// flash_get_order — order detail + fills
// ---------------------------------------------------------------------------
registerTool(
  "flash_get_order",
  {
    title: "Get a Flash order",
    description: "Fetch the status, fills, and details of a single order by id.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { orderId: z.string().describe("The order id returned at submit time") },
  },
  async (args) => {
    const { client } = await resolveClient();
    const res = await client.getOrder(args.orderId);
    return result(orderDetail(res), res);
  },
);

// ---------------------------------------------------------------------------
// flash_list_orders — recent orders for a funder
// ---------------------------------------------------------------------------
registerTool(
  "flash_list_orders",
  {
    title: "List Flash orders",
    description:
      "List recent orders for a funder wallet. Defaults to the configured EVM wallet if no address is given.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      funderAddress: z.string().optional().describe("Funder wallet address (defaults to configured EVM wallet)"),
      statuses: z
        .array(z.string())
        .optional()
        .describe("Filter by status, e.g. ORDER_STATUS_FILLED, ORDER_STATUS_PENDING"),
      pageSize: z.number().int().optional().describe("Number of orders to return (max 200, default 50)"),
    },
  },
  async (args) => {
    const { client } = await resolveClient();
    const funderAddress =
      (args.funderAddress as string | undefined) ?? (await funderAddressFor("base")) ?? (await funderAddressFor("solana"));
    if (!funderAddress) {
      return result("No funder address given and no wallet configured. Pass `funderAddress` or run `flash_setup`.");
    }
    const res = await client.listOrders({
      funderAddress,
      ...(args.statuses ? { statuses: args.statuses as FlashOrderStatus[] } : {}),
      ...(args.pageSize ? { pageSize: args.pageSize as number } : {}),
    });
    const summary = res.orders.length
      ? [`**${res.orders.length} order(s) for ${funderAddress}:**`, ...res.orders.map(orderLine)].join("\n")
      : `No orders found for ${funderAddress}.`;
    return result(summary, res);
  },
);

// ---------------------------------------------------------------------------
// flash_cancel_order — sign + submit a cancel
// ---------------------------------------------------------------------------
registerTool(
  "flash_cancel_order",
  {
    title: "Cancel a Flash order",
    description:
      "Cancel a resting order (limit/twap/trigger). Signs the cancel message with your funder wallet. " +
      "Requires the funder private key for the order's chain.",
    // Kills a resting order (destructive), but re-cancelling the same order is a no-op.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      orderId: z.string().describe("The order id to cancel"),
      chain: chainEnum.describe("The chain the order is on (selects which wallet signs)"),
    },
  },
  async (args) => {
    const client = await requireClient();
    const privateKey = await requirePrivateKey(args.chain);
    await cancelOrder(client, args.orderId, args.chain, privateKey);
    return result(`✅ Cancel submitted for order \`${args.orderId}\`. Confirm with \`flash_get_order\`.`);
  },
);

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function main() {
  // If invoked with a CLI subcommand (e.g. `flash-mcp set-key evm`), handle it
  // out-of-band and exit — do NOT start the server on stdio.
  if (process.argv.length > 2) {
    try {
      await runCli(process.argv.slice(2));
    } catch (err) {
      console.error(`❌ ${describeError(err)}`);
      process.exit(1);
    }
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so it doesn't corrupt the stdio JSON-RPC stream.
  console.error("definitive-flash MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

// Surface friendly errors for known failure types instead of raw stack traces.
export function describeError(err: unknown): string {
  if (err instanceof SetupError) return err.message;
  if (err instanceof FlashApiError) return `Flash API error (${err.status}${err.code ? ` ${err.code}` : ""}): ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
