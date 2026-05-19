/**
 * Pluggable price provider.
 *
 * Phase 2.1: gives the Dashboard a single source of fiat truth so the
 * hero can render `$X,XXX.XX` instead of "Total ARCH Balance".
 *
 * Provider chain:
 *   1. CoinGecko simple price for BTC and ARCH.
 *   2. Indexer token metadata for APL tokens (when it ships
 *      `usd_price`); falls back to 0 with a flag.
 *
 * Results are cached in chrome.storage.local for 5 minutes to keep
 * the dashboard snappy and avoid hammering CoinGecko while the user
 * flips between pages.
 */

import { getIndexer } from "./indexer";

export interface PriceEntry {
  usd: number;
  change24hPct?: number;
  updatedAt: number;
}

export interface PortfolioInput {
  btcSats: number;
  archLamports: string | number;
  tokens: { mint: string; rawAmount: string | number; decimals: number }[];
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
 * Compute the fiat valuation of a wallet snapshot. Tokens without a
 * price are returned with `usd: 0, unpriced: true` so the Dashboard
 * can render a "+N unpriced tokens" footnote rather than silently
 * dropping them.
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

  for (const t of input.tokens) {
    const raw = String(t.rawAmount);
    // APL prices not wired yet; track as unpriced.
    tokenBreakdown[t.mint] = { usd: 0, rawAmount: raw, decimals: t.decimals, unpriced: true };
  }

  const change24Numerator =
    (btc?.change24hPct ?? 0) * btcUsd + (arch?.change24hPct ?? 0) * archUsd;
  const change24Denominator = btcUsd + archUsd;
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
