/**
 * BTC -> USD price source. Uses CoinGecko's free /simple/price endpoint and
 * caches the result in chrome.storage.local for a few minutes so we don't
 * hammer the public API or block UI work on a network round-trip.
 *
 * Only mainnet BTC has a real fiat value; callers on testnet should skip
 * displaying USD entirely rather than show misleading numbers.
 */

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
const STORAGE_KEY = "arch_wallet_btc_price";
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_BUDGET_MS = 60 * 60 * 1000; // serve stale up to 1h on fetch failure

interface CachedPrice {
  price: number;
  fetchedAt: number;
}

let inflight: Promise<number | null> | null = null;

async function readCache(): Promise<CachedPrice | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const cached = result[STORAGE_KEY] as CachedPrice | undefined;
    if (!cached || typeof cached.price !== "number" || typeof cached.fetchedAt !== "number") {
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

async function writeCache(price: number): Promise<void> {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY]: { price, fetchedAt: Date.now() } satisfies CachedPrice,
    });
  } catch {
    /* ignore -- price caching is best-effort */
  }
}

async function fetchPriceFromApi(): Promise<number | null> {
  try {
    const res = await fetch(COINGECKO_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { bitcoin?: { usd?: number } };
    const price = json?.bitcoin?.usd;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
    return price;
  } catch {
    return null;
  }
}

export interface BtcUsdResult {
  /** Latest USD price for 1 BTC, or null if unavailable. */
  price: number | null;
  /** True when the value was served from cache. */
  fromCache: boolean;
  /** When the cached value was originally fetched. */
  fetchedAt: number | null;
}

/**
 * Returns the latest BTC->USD price.
 * - Fresh cache (< TTL): returned immediately.
 * - Stale cache (< STALE_BUDGET): returned immediately, then refreshed in
 *   the background.
 * - No cache or expired: fetched synchronously.
 *
 * The function never throws -- on failure `price` is null.
 */
export async function getBtcUsdPrice(): Promise<BtcUsdResult> {
  const cached = await readCache();
  const now = Date.now();

  if (cached && now - cached.fetchedAt < TTL_MS) {
    return { price: cached.price, fromCache: true, fetchedAt: cached.fetchedAt };
  }

  if (!inflight) {
    inflight = (async () => {
      const price = await fetchPriceFromApi();
      if (price != null) await writeCache(price);
      return price;
    })().finally(() => {
      inflight = null;
    });
  }

  if (cached && now - cached.fetchedAt < STALE_BUDGET_MS) {
    // Kick off the refresh but serve cached value immediately
    void inflight;
    return { price: cached.price, fromCache: true, fetchedAt: cached.fetchedAt };
  }

  const fresh = await inflight;
  return {
    price: fresh,
    fromCache: false,
    fetchedAt: fresh != null ? Date.now() : null,
  };
}
