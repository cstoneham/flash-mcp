// Read-only wallet balance lookups over the per-chain RPCs from chains.ts.
// No Flash API involvement — pure on-chain reads, safe without any credentials.

import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, erc20Abi, formatUnits, http, isAddress } from "viem";

import { getChain, resolveRpc } from "./chains.js";
import { discoverEvmTokens } from "./explorer.js";

export interface TokenBalance {
  /** ERC-20 address / SPL mint, or "native" for the gas asset. */
  token: string;
  symbol: string;
  /** Human units. */
  balance: string;
  /** Base units. */
  raw: string;
  decimals: number;
}

// SPL token program ids — lets us enumerate a wallet's token accounts without
// needing @solana/spl-token as a dependency.
const SPL_TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SPL_TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export async function fetchBalances(
  chainName: string,
  address: string,
  tokens?: string[],
  rpcOverride?: string,
): Promise<TokenBalance[]> {
  const chain = getChain(chainName);
  const rpc = resolveRpc(chainName, rpcOverride);
  return chain.kind === "svm"
    ? svmBalances(rpc, address, tokens)
    : evmBalances(rpc, chain.nativeSymbol, address, tokens, chain.explorerApi);
}

async function evmBalances(
  rpc: string,
  nativeSymbol: string,
  address: string,
  tokens?: string[],
  explorerApi?: string,
): Promise<TokenBalance[]> {
  if (!isAddress(address)) throw new Error(`"${address}" is not a valid EVM address`);
  const client = createPublicClient({ transport: http(rpc) });

  const native = client.getBalance({ address }).then(
    (wei): TokenBalance => ({
      token: "native",
      symbol: nativeSymbol,
      balance: formatUnits(wei, 18),
      raw: wei.toString(),
      decimals: 18,
    }),
  );

  // Explicit `tokens` are read exactly as given (and back-filled with zeros so a
  // caller always gets a row per requested address). When none are passed we
  // enumerate the wallet's holdings from the chain's block explorer, then hide
  // empty balances — mirroring how Solana lists everything a wallet holds.
  const explicit = !!tokens && tokens.length > 0;
  let tokenList = tokens ?? [];
  let dropZero = false;
  if (!explicit && explorerApi) {
    try {
      tokenList = await discoverEvmTokens(explorerApi, address);
      dropZero = true;
    } catch {
      tokenList = []; // explorer unavailable — fall back to native-only
    }
  }

  const erc20s = await Promise.all(
    tokenList.map(async (token): Promise<TokenBalance | null> => {
      if (!isAddress(token)) {
        if (explicit) throw new Error(`"${token}" is not a valid ERC-20 address`);
        return null; // ignore anything malformed the explorer hands back
      }
      const contract = { address: token, abi: erc20Abi } as const;
      try {
        const [raw, decimals, symbol] = await Promise.all([
          client.readContract({ ...contract, functionName: "balanceOf", args: [address] }),
          client.readContract({ ...contract, functionName: "decimals" }),
          client.readContract({ ...contract, functionName: "symbol" }).catch(() => token.slice(0, 8)),
        ]);
        return { token, symbol, balance: formatUnits(raw, decimals), raw: raw.toString(), decimals };
      } catch (err) {
        if (explicit) throw err;
        return null; // a discovered token that won't read cleanly — skip it
      }
    }),
  );

  const out = [await native, ...erc20s.filter((b): b is TokenBalance => b !== null)];
  return dropZero ? out.filter((b) => b.token === "native" || b.raw !== "0") : out;
}

async function svmBalances(rpc: string, address: string, tokens?: string[]): Promise<TokenBalance[]> {
  const connection = new Connection(rpc, "confirmed");
  const owner = new PublicKey(address);

  const lamports = await connection.getBalance(owner);
  const out: TokenBalance[] = [
    {
      token: "native",
      symbol: "SOL",
      balance: formatUnits(BigInt(lamports), 9),
      raw: String(lamports),
      decimals: 9,
    },
  ];

  // One call per token program returns every SPL balance the wallet holds; the
  // optional `tokens` list then just filters by mint.
  const accounts = (
    await Promise.all(
      [SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM].map((programId) =>
        connection.getParsedTokenAccountsByOwner(owner, { programId }),
      ),
    )
  ).flatMap((res) => res.value);

  const wanted = tokens ? new Set(tokens) : null;
  for (const { account } of accounts) {
    const info = account.data.parsed?.info;
    const mint: string | undefined = info?.mint;
    const amount = info?.tokenAmount;
    if (!mint || !amount) continue;
    if (wanted && !wanted.has(mint)) continue;
    if (!wanted && amount.amount === "0") continue; // skip empty accounts when listing everything
    out.push({
      token: mint,
      symbol: mint.slice(0, 8),
      balance: amount.uiAmountString ?? String(amount.uiAmount ?? amount.amount),
      raw: amount.amount,
      decimals: amount.decimals,
    });
  }

  if (wanted) {
    for (const mint of wanted) {
      if (!out.some((b) => b.token === mint)) {
        out.push({ token: mint, symbol: mint.slice(0, 8), balance: "0", raw: "0", decimals: 0 });
      }
    }
  }

  return out;
}
