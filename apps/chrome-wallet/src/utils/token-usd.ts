/**
 * USD pricing for APL tokens.
 *
 * APL mints carry no price feed of their own, but the first-party
 * mints in the known-token registry are pegged to an asset we *can*
 * price: aBTC is wrapped Bitcoin (engine symbol "BTC") and tracks
 * BTC/USD; the dollar-pegged mints (aUSD / USDC / USDT) are held at
 * $1. The peg is read off the engine's canonical symbol rather than
 * the wallet's display symbol, because the display layer renames
 * BTC -> aBTC while the engine keeps "BTC" as the routing key.
 *
 * Mints outside the registry return `null` — "we don't know what this
 * is worth" — which callers must keep distinct from a $0 valuation so
 * the UI can omit the fiat line instead of claiming a token is
 * worthless.
 */

import type { TokenSymbol } from "@arch/swap-engine";

import { lookupKnownToken } from "./known-tokens";
import type { NetworkId } from "../state/types";

/** True when the asset's USD price is the live BTC price. */
export function tracksBtcPrice(symbol: TokenSymbol): boolean {
  return symbol === "BTC";
}

/**
 * USD value of one whole unit of an engine asset.
 *
 * `btcUsd` doubles as the caller's "is fiat available here?" signal —
 * it is null when the price feed is down and on testnet, where the
 * wallet deliberately withholds real-world prices. Dollar-pegged
 * assets therefore stay unpriced in that state too, rather than
 * putting real dollars next to a test-coin balance.
 */
export function usdPerUnitForSymbol(
  symbol: TokenSymbol,
  btcUsd: number | null | undefined,
): number | null {
  const haveFiat = btcUsd != null && Number.isFinite(btcUsd) && btcUsd > 0;
  if (!haveFiat) return null;
  if (tracksBtcPrice(symbol)) return btcUsd;
  if (symbol === "USDC" || symbol === "USDT") return 1;
  return null;
}

/** The engine's canonical symbol for a mint, in hex or base58 form. */
export function engineSymbolForMint(
  mint: string,
  network: NetworkId,
): TokenSymbol | null {
  return lookupKnownToken(mint, network)?.engineSymbol ?? null;
}

/** USD value of one whole token of a known mint; null if unpriceable. */
export function usdPerUnitForMint(
  mint: string,
  network: NetworkId,
  btcUsd: number | null | undefined,
): number | null {
  const symbol = engineSymbolForMint(mint, network);
  return symbol ? usdPerUnitForSymbol(symbol, btcUsd) : null;
}

/**
 * USD value of a raw (atomic) token balance. Returns null when the
 * unit price is unknown so callers can render nothing rather than
 * "$0.00".
 */
export function tokenUsdValue(
  rawAmount: string | number,
  decimals: number,
  usdPerUnit: number | null,
): number | null {
  if (usdPerUnit == null) return null;
  const raw = Number(rawAmount);
  if (!Number.isFinite(raw)) return null;
  return (raw / Math.pow(10, decimals)) * usdPerUnit;
}

/**
 * USD value of a user-typed token amount in whole units.
 *
 * Send forms keep the amount as a decimal string ("0.001"), not an
 * atomic balance. Empty, partial ("0."), and non-positive input return
 * null so the fiat hint stays hidden until the amount is a real send.
 */
export function displayAmountUsd(
  displayAmount: string,
  usdPerUnit: number | null | undefined,
): number | null {
  if (usdPerUnit == null || !Number.isFinite(usdPerUnit) || usdPerUnit <= 0) return null;
  const trimmed = displayAmount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const units = Number(trimmed);
  if (!Number.isFinite(units) || units <= 0) return null;
  return units * usdPerUnit;
}
