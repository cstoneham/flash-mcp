// Chain metadata for every chain the Flash API supports.
//
// `kind` decides which signer path a trade takes (EVM via viem, SVM via web3.js).
// EVM chains need an RPC to send the optional approve / wrap transactions and to
// wait for their receipts; signing the order itself reads the chainId straight
// from the quote's EIP-712 domain, so the RPC is only used for on-chain sends.

import { getRpcOverride } from "./config.js";

export type ChainKind = "evm" | "svm";

export interface ChainInfo {
  /** Flash API chain identifier (the value sent as targetChain/contraChain). */
  id: string;
  kind: ChainKind;
  /** EVM numeric chain id. Undefined for Solana. */
  chainId?: number;
  /** Native gas-asset symbol, for display. */
  nativeSymbol: string;
  /** Default public RPC. Overridable per chain via env or per call. */
  defaultRpc: string;
  /**
   * Blockscout API base (no trailing slash). When set, `flash_balances` can
   * auto-discover the wallet's ERC-20 holdings instead of requiring explicit
   * token addresses. Discovery is best-effort — a failure falls back to
   * native-only, and every balance is still read live on-chain.
   */
  explorerApi?: string;
}

export const CHAINS: Record<string, ChainInfo> = {
  ethereum: { id: "ethereum", kind: "evm", chainId: 1, nativeSymbol: "ETH", defaultRpc: "https://eth.llamarpc.com", explorerApi: "https://eth.blockscout.com" },
  optimism: { id: "optimism", kind: "evm", chainId: 10, nativeSymbol: "ETH", defaultRpc: "https://mainnet.optimism.io", explorerApi: "https://optimism.blockscout.com" },
  bsc: { id: "bsc", kind: "evm", chainId: 56, nativeSymbol: "BNB", defaultRpc: "https://bsc-dataseed.binance.org" },
  polygon: { id: "polygon", kind: "evm", chainId: 137, nativeSymbol: "POL", defaultRpc: "https://polygon-rpc.com", explorerApi: "https://polygon.blockscout.com" },
  base: { id: "base", kind: "evm", chainId: 8453, nativeSymbol: "ETH", defaultRpc: "https://mainnet.base.org", explorerApi: "https://base.blockscout.com" },
  arbitrum: { id: "arbitrum", kind: "evm", chainId: 42161, nativeSymbol: "ETH", defaultRpc: "https://arb1.arbitrum.io/rpc", explorerApi: "https://arbitrum.blockscout.com" },
  avalanche: { id: "avalanche", kind: "evm", chainId: 43114, nativeSymbol: "AVAX", defaultRpc: "https://api.avax.network/ext/bc/C/rpc" },
  hyperevm: { id: "hyperevm", kind: "evm", chainId: 999, nativeSymbol: "HYPE", defaultRpc: "https://rpc.hyperliquid.xyz/evm" },
  robinhood: { id: "robinhood", kind: "evm", chainId: 4663, nativeSymbol: "ETH", defaultRpc: "https://rpc.mainnet.chain.robinhood.com", explorerApi: "https://robinhoodchain.blockscout.com" },
  plasma: { id: "plasma", kind: "evm", chainId: 9745, nativeSymbol: "XPL", defaultRpc: "https://rpc.plasma.to", explorerApi: "https://plasma.blockscout.com" },
  monad: { id: "monad", kind: "evm", chainId: 143, nativeSymbol: "MON", defaultRpc: "https://rpc.monad.xyz" },
  solana: { id: "solana", kind: "svm", nativeSymbol: "SOL", defaultRpc: "https://api.mainnet-beta.solana.com" },
};

export const CHAIN_IDS = Object.keys(CHAINS);

export function getChain(id: string): ChainInfo {
  const c = CHAINS[id];
  if (!c) {
    throw new Error(`Unknown chain "${id}". Supported chains: ${CHAIN_IDS.join(", ")}`);
  }
  return c;
}

/**
 * Resolve the RPC URL to use for a chain. Precedence:
 *   1. explicit override (per-call rpcUrl argument)
 *   2. DEFINITIVE_RPC_<CHAIN> env var (e.g. DEFINITIVE_RPC_BASE)
 *   3. RPC set via `flash_setup` (persisted config file)
 *   4. the chain's default public RPC
 */
export function resolveRpc(chainId: string, override?: string): string {
  if (override) return override;
  const envKey = `DEFINITIVE_RPC_${chainId.toUpperCase()}`;
  const fromEnv = process.env[envKey];
  if (fromEnv) return fromEnv;
  const fromConfig = getRpcOverride(chainId);
  if (fromConfig) return fromConfig;
  return getChain(chainId).defaultRpc;
}

/**
 * True when the call would fall back to the chain's built-in public RPC — i.e.
 * no per-call override, no env var, and nothing set via `flash_setup`. These
 * public endpoints are heavily rate-limited, so callers surface a nudge to
 * configure a real RPC for complete, reliable balance reads.
 */
export function usingDefaultRpc(chainId: string, override?: string): boolean {
  return resolveRpc(chainId, override) === getChain(chainId).defaultRpc;
}
