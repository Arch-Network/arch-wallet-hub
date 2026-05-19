// Indexer-backed token balance reads.
//
// All calls go through `/accounts/{address}/token-balances`, which the
// indexer matches on `owner_address OR account_address` — pass an owner
// to get a row per token account they hold, or pass a single token
// account address (e.g. an AMM vault) to get that one row.

import { indexerFetch } from "@/lib/indexer/client";

export type TokenBalanceEntry = {
  mint_address: string;
  mint_address_hex: string;
  balance: string;
  decimals: number;
  owner_address?: string;
  program_id?: string;
  program_name?: string | null;
  supply?: string | null;
  is_frozen?: boolean;
  last_updated?: string;
};

type AccountTokenBalancesResponse = {
  balances: TokenBalanceEntry[];
  total: number | null;
  page: number;
  limit: number;
  has_more?: boolean;
};

/**
 * Fetch token balance rows associated with `archAddress`. Limit defaults
 * to 25 — raise it for wallets expected to hold more distinct tokens.
 */
export async function fetchAccountTokenBalances(
  archAddress: string,
  options?: { limit?: number; page?: number },
): Promise<TokenBalanceEntry[]> {
  const limit = options?.limit ?? 25;
  const page = options?.page ?? 1;
  const response = await indexerFetch<AccountTokenBalancesResponse>(
    `/accounts/${encodeURIComponent(archAddress)}/token-balances?limit=${limit}&page=${page}`,
  );
  return response.balances;
}

/**
 * Fetch balances filtered to a specific set of mints, keyed by the mint
 * hex string the caller supplied. Mints with no matching token account
 * map to `0n` so every requested mint is always present in the result.
 */
export async function fetchTokenBalancesByMint(
  ownerArchAddress: string,
  mintHexes: readonly string[],
): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  for (const mint of mintHexes) out[mint] = 0n;

  // Case-insensitive lookup; the original casing is preserved in the
  // output keys so callers don't have to normalize.
  const wantedByLower = new Map(
    mintHexes.map((m) => [m.toLowerCase(), m]),
  );

  const entries = await fetchAccountTokenBalances(ownerArchAddress);
  for (const entry of entries) {
    const originalKey = wantedByLower.get(entry.mint_address_hex.toLowerCase());
    if (originalKey) {
      out[originalKey] = BigInt(entry.balance);
    }
  }
  return out;
}

/**
 * Fetch the SPL amount in a single token account (typically an AMM pool
 * vault). Returns `null` — not `0n` — when the indexer has no record of
 * the account yet, so callers can distinguish "indexer can't confirm"
 * from "verified empty."
 */
export async function fetchTokenAccountBalance(
  tokenAccountArchAddress: string,
): Promise<bigint | null> {
  const entries = await fetchAccountTokenBalances(tokenAccountArchAddress);
  if (entries.length === 0) return null;
  // The endpoint matches `account_address` so we expect 0 or 1 rows. If
  // multiple come back, prefer the row keyed by `account_address` itself.
  const match = entries.find(
    (e) => e.owner_address?.toLowerCase() !== tokenAccountArchAddress.toLowerCase(),
  );
  return BigInt((match ?? entries[0]).balance);
}
