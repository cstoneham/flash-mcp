// ERC-20 token discovery via a chain's Blockscout REST API.
//
// EVM RPCs have no "list every token this wallet holds" primitive the way
// Solana does, so we borrow the address list from a block explorer. We trust
// the explorer only for *which* tokens exist — every balance is re-read live
// on-chain in balances.ts, since an explorer's cached balances can be stale.

interface BlockscoutTokenListResponse {
  status?: string;
  message?: string;
  result?: Array<{ contractAddress?: string; type?: string }>;
}

/**
 * Return the ERC-20 contract addresses a wallet holds, via the Blockscout
 * Etherscan-compatible endpoint (`?module=account&action=tokenlist`). NFTs
 * (ERC-721/1155) are filtered out — they have no scalar balance to read.
 * Throws on network / non-200 responses so the caller can fall back to
 * native-only.
 */
export async function discoverEvmTokens(explorerApi: string, address: string): Promise<string[]> {
  const base = explorerApi.replace(/\/+$/, "");
  const url = `${base}/api?module=account&action=tokenlist&address=${address}`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`token discovery failed (${res.status})`);

  const body = (await res.json()) as BlockscoutTokenListResponse;
  const rows = Array.isArray(body.result) ? body.result : [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const addr = row.contractAddress;
    if (!addr) continue;
    if (row.type && !row.type.toUpperCase().includes("ERC-20")) continue; // skip NFTs
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}
