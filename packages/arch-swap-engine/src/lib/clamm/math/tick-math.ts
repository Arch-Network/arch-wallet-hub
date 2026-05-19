import { MAX_TICK_INDEX, MIN_TICK_INDEX, MIN_SQRT_PRICE, MAX_SQRT_PRICE } from "@/lib/clamm/constants";

// ── Q64.64 fixed-point helpers ─────────────────────────────────────────────

const Q64 = 1n << 64n;

/**
 * Convert a tick index to a sqrt price in Q64.64 format.
 *
 * sqrt(1.0001^tick) = 1.0001^(tick/2).
 * Uses JavaScript float math — accurate to ~15 significant digits,
 * which is sufficient for UI quote estimation.
 */
export function tickIndexToSqrtPrice(tickIndex: number): bigint {
  if (tickIndex < MIN_TICK_INDEX || tickIndex > MAX_TICK_INDEX) {
    throw new Error(`Tick index ${tickIndex} out of range [${MIN_TICK_INDEX}, ${MAX_TICK_INDEX}]`);
  }

  // 1.0001^(tick/2) via exp/log for full range precision
  const sqrtPriceF = Math.exp((tickIndex / 2) * Math.log(1.0001));
  return BigInt(Math.round(sqrtPriceF * Number(Q64)));
}

/**
 * Convert a sqrt price (Q64.64) to the nearest tick index.
 *
 * Uses a binary search approach to find the tick whose sqrt price
 * is <= the given sqrt price.
 */
export function sqrtPriceToTickIndex(sqrtPrice: bigint): number {
  if (sqrtPrice < MIN_SQRT_PRICE || sqrtPrice > MAX_SQRT_PRICE) {
    throw new Error("Sqrt price out of range");
  }

  // Binary search for tick index
  let low = MIN_TICK_INDEX;
  let high = MAX_TICK_INDEX;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const midPrice = tickIndexToSqrtPrice(mid);

    if (midPrice <= sqrtPrice) {
      const nextPrice = mid < MAX_TICK_INDEX ? tickIndexToSqrtPrice(mid + 1) : MAX_SQRT_PRICE + 1n;
      if (nextPrice > sqrtPrice) {
        return mid;
      }
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return low;
}

/**
 * Convert a sqrt price (Q64.64) to a human-readable price.
 * price = (sqrtPrice / 2^64)^2 * 10^(decimalsA - decimalsB)
 */
export function sqrtPriceToPrice(sqrtPrice: bigint, decimalsA: number, decimalsB: number): number {
  const sqrtPriceF = Number(sqrtPrice) / Number(Q64);
  const price = sqrtPriceF * sqrtPriceF;
  const decimalAdjustment = Math.pow(10, decimalsA - decimalsB);
  return price * decimalAdjustment;
}

/**
 * Convert a human-readable price to sqrt price (Q64.64).
 */
export function priceToSqrtPrice(price: number, decimalsA: number, decimalsB: number): bigint {
  const decimalAdjustment = Math.pow(10, decimalsA - decimalsB);
  const adjustedPrice = price / decimalAdjustment;
  const sqrtPriceF = Math.sqrt(adjustedPrice);
  return BigInt(Math.floor(sqrtPriceF * Number(Q64)));
}

/**
 * Convert a price to the nearest tick index.
 */
export function priceToTickIndex(price: number, decimalsA: number, decimalsB: number): number {
  const sqrtPrice = priceToSqrtPrice(price, decimalsA, decimalsB);
  return sqrtPriceToTickIndex(sqrtPrice);
}

/**
 * Convert a tick index to a human-readable price.
 */
export function tickIndexToPrice(tickIndex: number, decimalsA: number, decimalsB: number): number {
  const sqrtPrice = tickIndexToSqrtPrice(tickIndex);
  return sqrtPriceToPrice(sqrtPrice, decimalsA, decimalsB);
}

/**
 * Get the nearest valid tick index that is a multiple of tickSpacing.
 */
export function getNearestValidTickIndex(tickIndex: number, tickSpacing: number): number {
  const rounded = Math.round(tickIndex / tickSpacing) * tickSpacing;
  return Math.max(MIN_TICK_INDEX, Math.min(MAX_TICK_INDEX, rounded));
}
