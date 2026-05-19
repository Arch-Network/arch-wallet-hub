/**
 * BTC USD price accessor used by `swap/quote-client.ts` when the PropAMM
 * response doesn't contain a parseable amount field. The host injects the
 * actual price provider via `configureEngine({ prices: { getBtcUsdPrice } })`.
 */

import { getEngineConfig } from "@/engine-config";
import type { NetworkConfig } from "@/lib/network/config";

/**
 * Returns BTC price in USD. The `config` parameter is accepted for source
 * compatibility with upstream arch-swap's signature but is intentionally
 * unused -- the engine config provides the price provider directly so the
 * host can swap implementations (CoinGecko, on-chain oracle, etc.).
 */
export async function getBtcUsdPrice(_config?: NetworkConfig): Promise<number> {
  const cfg = getEngineConfig();
  const price = await cfg.prices.getBtcUsdPrice();
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Engine price provider returned an invalid BTC price: ${price}`);
  }
  return price;
}
