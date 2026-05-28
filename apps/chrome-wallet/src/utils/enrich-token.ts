/**
 * Single source of truth for "what should this token look like in the
 * UI?" Replaces three near-identical enrichment blocks (Dashboard,
 * TokenList, TokenDetail) that all reimplemented the same priority
 * order with subtle drift between them.
 *
 * Priority (highest wins):
 *   1. Known-mint registry (wallet-curated; for arch-swap mints +
 *      anything else we hand-register). Authoritative — never
 *      overridden by indexer/RPC data.
 *   2. Indexer's own metadata fields (`name`, `symbol`, `decimals`,
 *      `ui_amount`, `image`). Cheap; arrives in the same response as
 *      the balance, no extra round-trip.
 *   3. APL RPC enrichment (metadata PDA + mint info). Slower —
 *      involves derivePDA + extra reads — but unlocks decimals + UI
 *      amount + image when neither the registry nor the indexer
 *      knew.
 *   4. Truncated-mint fallback. Last resort so we never render
 *      "undefined" or a raw 64-char base58 in the symbol slot.
 *
 * The function is deliberately decoupled from the React layer so it
 * stays unit-testable: pass in the raw indexer row + the network +
 * (optional) indexer client and get back a flat `EnrichedToken` you
 * can hand straight to a row component.
 */

import type { IndexerClient } from "./indexer";
import { enrichTokenFromRpc } from "./arch-rpc";
import { formatTokenAmount, truncateAddress } from "./format";
import { lookupKnownToken } from "./known-tokens";
import type { NetworkId } from "../state/types";

/**
 * Subset of `getAccountTokens` row fields we read here. Loosened to
 * `unknown` for forward-compat with indexer additions.
 */
export interface RawIndexerToken {
  mint_address: string;
  amount?: string | number;
  decimals?: number | null;
  name?: string | null;
  symbol?: string | null;
  image?: string | null;
  ui_amount?: string | null;
  token_account_address?: string | null;
  [key: string]: unknown;
}

export interface EnrichedToken {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  uiAmount: string;
  image?: string;
  tokenAccount: string;
  /** Where the displayed `symbol`/`name` came from. Useful for
   *  analytics + for tests that want to assert "this row used the
   *  registry, not the truncation fallback". */
  source: "registry" | "indexer" | "rpc" | "fallback";
}

/**
 * Resolve an indexer token row into a display-ready `EnrichedToken`.
 *
 * `indexer` is optional — if omitted (e.g. unit tests, or pages that
 * deliberately skip the round-trip), the function will skip step 3 and
 * fall straight from indexer → fallback. This is safe in practice
 * because the registry already covers our priority tokens (BTC, USDC)
 * and the indexer covers any popular community token.
 */
export async function enrichIndexerToken(
  raw: RawIndexerToken,
  network: NetworkId,
  indexer?: IndexerClient,
): Promise<EnrichedToken> {
  const mint = raw.mint_address;
  const rawAmount = Number(raw.amount) || 0;

  // Step 1 — wallet-curated registry. Highest priority, zero I/O.
  const known = lookupKnownToken(mint, network);
  if (known) {
    return {
      mint,
      symbol: known.symbol,
      name: known.name,
      balance: rawAmount,
      decimals: known.decimals,
      uiAmount: formatTokenAmount(rawAmount, known.decimals),
      image: known.icon,
      tokenAccount: (raw.token_account_address ?? "") as string,
      source: "registry",
    };
  }

  // Step 2 — indexer-supplied metadata. Use what's already on the wire.
  const indexerName = raw.name ?? "";
  const indexerSymbol = raw.symbol ?? "";
  const indexerDecimals = raw.decimals ?? 0;
  const indexerImage = (raw.image ?? undefined) as string | undefined;
  const indexerUiAmount =
    (raw.ui_amount as string | null | undefined) ??
    (indexerDecimals
      ? formatTokenAmount(rawAmount, indexerDecimals)
      : undefined);

  let symbol = indexerSymbol;
  let name = indexerName;
  let decimals = indexerDecimals;
  let image = indexerImage;
  let uiAmount = indexerUiAmount ?? formatTokenAmount(rawAmount, decimals);
  let source: EnrichedToken["source"] = "indexer";

  // Step 3 — APL RPC enrichment when the indexer left holes and we
  // have an indexer client to fill them with. The RPC call is the
  // most expensive branch, so we gate it on actually-missing fields.
  const needsRpc =
    !!indexer &&
    (!symbol ||
      !name ||
      (!decimals && decimals !== 0 && raw.decimals !== 0));
  if (needsRpc) {
    try {
      const rpc = await enrichTokenFromRpc(indexer, raw);
      if (rpc.name) {
        name = rpc.name;
        source = "rpc";
      }
      if (rpc.symbol) {
        symbol = rpc.symbol;
        source = "rpc";
      }
      if (rpc.image) image = rpc.image;
      if (rpc.decimals != null) decimals = rpc.decimals;
      if (rpc.uiAmount) uiAmount = rpc.uiAmount;
    } catch {
      // Best-effort. Fall through to the fallback step.
    }
  }

  // Step 4 — fallback. Never render "undefined" or a bare 64-char
  // mint in the symbol/name slot.
  if (!symbol) {
    symbol = truncateAddress(mint, 4);
    source = "fallback";
  }
  if (!name) {
    name = "APL Token";
    if (source !== "rpc") source = "fallback";
  }

  return {
    mint,
    symbol,
    name,
    balance: rawAmount,
    decimals,
    uiAmount,
    image,
    tokenAccount: (raw.token_account_address ?? "") as string,
    source,
  };
}

/**
 * Convenience wrapper that runs enrichment over a batch of raw rows in
 * parallel. Mirrors what the existing call sites do today.
 */
export async function enrichIndexerTokens(
  rows: RawIndexerToken[],
  network: NetworkId,
  indexer?: IndexerClient,
): Promise<EnrichedToken[]> {
  return Promise.all(rows.map((r) => enrichIndexerToken(r, network, indexer)));
}
