/**
 * Pluggable price provider.
 *
 * Phase 2.1: gives the Dashboard a single source of fiat truth so the
 * hero can render `$X,XXX.XX` instead of "Total ARCH Balance".
 *
 * Provider chain:
 *   1. CoinGecko simple price for BTC and ARCH.
 *   2. Peg-derived prices for known APL mints (see `token-usd`):
 *      wrapped BTC at the BTC rate, dollar-pegged mints at $1.
 *   3. Indexer token metadata for everything else (when it ships
 *      `usd_price`); falls back to 0 with a flag.
 *
 * Results are cached in chrome.storage.local for 5 minutes to keep
 * the dashboard snappy and avoid hammering CoinGecko while the user
 * flips between pages.
 */

import { getIndexer } from "./indexer";
import { engineSymbolForMint, tokenUsdValue, tracksBtcPrice, usdPerUnitForSymbol } from "./token-usd";
import type { NetworkId } from "../state/types";

export interface PriceEntry {
  usd: number;
  change24hPct?: number;
  updatedAt: number;
}

export interface PortfolioInput {
  btcSats: number;
  archLamports: string | number;
  tokens: { mint: string; rawAmount: string | number; decimals: number }[];
  /** Needed to resolve mints against the known-token registry, which
   *  is per-network. */
  network: NetworkId;
}

export interface PortfolioValuation {
  btcUsd: number;
  archUsd: number;
  tokenUsd: number;
  totalUsd: number;
  /** Weighted 24h percent change across priced positions. Null if no priced positions. */
  change24hPct: number | null;
  /** Per-mint USD breakdown (mints with no price get 0 here). */
  tokenBreakdown: Record<string, { usd: number; rawAmount: string; decimals: number; unpriced: boolean }>;
}

const CACHE_KEY = "arch_wallet_price_cache_v1";
const CACHE_TTL_MS = 5 * 60 * 1000;
const BTC_LAMPORTS = 1_0000_0000n;
const ARCH_LAMPORTS = 1_0000_0000n;

interface CacheShape {
  btc?: PriceEntry;
  arch?: PriceEntry;
  tokens?: Record<string, PriceEntry>;
}

async function readCache(): Promise<CacheShape> {
  try {
    const res = await chrome.storage.local.get(CACHE_KEY);
    return (res?.[CACHE_KEY] as CacheShape | undefined) ?? {};
  } catch {
    return {};
  }
}

async function writeCache(next: CacheShape): Promise<void> {
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: next });
  } catch {
    /* ignore */
  }
}

function isFresh(entry: PriceEntry | undefined): boolean {
  return !!entry && Date.now() - entry.updatedAt < CACHE_TTL_MS;
}

async function fetchCoinGecko(ids: string[]): Promise<Record<string, PriceEntry>> {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const json = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
  const now = Date.now();
  const out: Record<string, PriceEntry> = {};
  for (const id of ids) {
    const row = json[id];
    if (!row?.usd) continue;
    out[id] = { usd: row.usd, change24hPct: row.usd_24h_change, updatedAt: now };
  }
  return out;
}

export async function getBtcArchPrices(): Promise<{ btc: PriceEntry | null; arch: PriceEntry | null }> {
  const cache = await readCache();
  let btc = cache.btc;
  let arch = cache.arch;

  if (!isFresh(btc) || !isFresh(arch)) {
    try {
      // Note: ARCH may not be on CoinGecko yet; the call will simply
      // omit the entry and we fall back to whatever's cached.
      const fresh = await fetchCoinGecko(["bitcoin", "arch-network"]);
      if (fresh["bitcoin"]) btc = fresh["bitcoin"];
      if (fresh["arch-network"]) arch = fresh["arch-network"];
      await writeCache({ ...cache, btc, arch });
    } catch {
      /* keep cached entries, even if stale */
    }
  }

  return { btc: btc ?? null, arch: arch ?? null };
}

/**
 * Compute the fiat valuation of a wallet snapshot. APL tokens are
 * priced off the asset their mint is pegged to (see `token-usd`), so
 * a wrapped-BTC balance counts toward the total at the BTC rate.
 * Tokens we can't price are returned with `usd: 0, unpriced: true` so
 * the Dashboard can render a "+N unpriced tokens" footnote rather
 * than silently dropping them.
 */
export async function valuatePortfolio(input: PortfolioInput): Promise<PortfolioValuation> {
  const { btc, arch } = await getBtcArchPrices();

  const btcWhole = Number(BigInt(input.btcSats) / 1n) / Number(BTC_LAMPORTS);
  const btcUsd = btc ? btcWhole * btc.usd : 0;

  const archLamportsBig = BigInt(input.archLamports);
  const archWhole = Number(archLamportsBig) / Number(ARCH_LAMPORTS);
  const archUsd = arch ? archWhole * arch.usd : 0;

  const tokenBreakdown: PortfolioValuation["tokenBreakdown"] = {};
  let tokenUsd = 0;
  // BTC-pegged tokens move with BTC, so they carry its 24h change into
  // the weighted average; dollar-pegged ones contribute 0.
  let btcPeggedTokenUsd = 0;

  for (const t of input.tokens) {
    const raw = String(t.rawAmount);
    const symbol = engineSymbolForMint(t.mint, input.network);
    const usd = symbol
      ? tokenUsdValue(t.rawAmount, t.decimals, usdPerUnitForSymbol(symbol, btc?.usd ?? null))
      : null;
    if (usd == null) {
      tokenBreakdown[t.mint] = { usd: 0, rawAmount: raw, decimals: t.decimals, unpriced: true };
      continue;
    }
    tokenBreakdown[t.mint] = { usd, rawAmount: raw, decimals: t.decimals, unpriced: false };
    tokenUsd += usd;
    if (symbol && tracksBtcPrice(symbol)) btcPeggedTokenUsd += usd;
  }

  const change24Numerator =
    (btc?.change24hPct ?? 0) * (btcUsd + btcPeggedTokenUsd) +
    (arch?.change24hPct ?? 0) * archUsd;
  const change24Denominator = btcUsd + archUsd + tokenUsd;
  const change24hPct =
    change24Denominator > 0 ? change24Numerator / change24Denominator : null;

  return {
    btcUsd,
    archUsd,
    tokenUsd,
    totalUsd: btcUsd + archUsd + tokenUsd,
    change24hPct,
    tokenBreakdown,
  };
}

/**
 * Best-effort APL token price enrichment. Returns a price entry when
 * the indexer surfaces a `usd_price` field on the token metadata.
 * Falls through gracefully when the field is missing.
 */
export async function getTokenPrice(mint: string): Promise<PriceEntry | null> {
  const cache = await readCache();
  const cached = cache.tokens?.[mint];
  if (isFresh(cached)) return cached!;
  try {
    const indexer = await getIndexer();
    const meta = await indexer.getTokenDetail(mint);
    const usd = (meta as any)?.usd_price ?? (meta as any)?.price_usd;
    if (typeof usd === "number" && Number.isFinite(usd)) {
      const entry: PriceEntry = { usd, updatedAt: Date.now() };
      await writeCache({ ...cache, tokens: { ...(cache.tokens ?? {}), [mint]: entry } });
      return entry;
    }
  } catch {
    /* swallow */
  }
  return null;
}
