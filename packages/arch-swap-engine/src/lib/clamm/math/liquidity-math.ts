import { tickIndexToSqrtPrice } from "@/lib/clamm/math/tick-math";
import { getAmountDeltaA, getAmountDeltaB } from "@/lib/clamm/math/token-math";
import type { WhirlpoolState } from "@/lib/clamm/types";

const Q64 = 1n << 64n;

// ── Liquidity from token amounts ───────────────────────────────────────────

/**
 * Given a token A amount, compute how much liquidity can be added and
 * the estimated token B amount required.
 */
export function increaseLiquidityQuoteA(
  tokenAmountA: bigint,
  slippageBps: number,
  pool: WhirlpoolState,
  tickLower: number,
  tickUpper: number,
): { liquidityDelta: bigint; tokenMaxA: bigint; tokenMaxB: bigint; tokenEstA: bigint; tokenEstB: bigint } {
  const sqrtPriceLower = tickIndexToSqrtPrice(tickLower);
  const sqrtPriceUpper = tickIndexToSqrtPrice(tickUpper);
  const currentSqrtPrice = pool.sqrtPrice;

  let liquidity: bigint;
  let estA: bigint;
  let estB: bigint;

  if (currentSqrtPrice <= sqrtPriceLower) {
    // Current price is below range: all token A
    liquidity = getLiquidityFromAmountA(sqrtPriceLower, sqrtPriceUpper, tokenAmountA);
    estA = tokenAmountA;
    estB = 0n;
  } else if (currentSqrtPrice >= sqrtPriceUpper) {
    // Current price is above range: all token B
    // Can't quote from A when price above range
    liquidity = 0n;
    estA = 0n;
    estB = 0n;
  } else {
    // Price is within range: need both tokens
    liquidity = getLiquidityFromAmountA(currentSqrtPrice, sqrtPriceUpper, tokenAmountA);
    estA = tokenAmountA;
    estB = getAmountDeltaB(sqrtPriceLower, currentSqrtPrice, liquidity, true);
  }

  const slippageFactor = BigInt(10000 + slippageBps);
  const tokenMaxA = (estA * slippageFactor + 9999n) / 10000n;
  const tokenMaxB = (estB * slippageFactor + 9999n) / 10000n;

  return { liquidityDelta: liquidity, tokenMaxA, tokenMaxB, tokenEstA: estA, tokenEstB: estB };
}

/**
 * Given a token B amount, compute how much liquidity can be added and
 * the estimated token A amount required.
 */
export function increaseLiquidityQuoteB(
  tokenAmountB: bigint,
  slippageBps: number,
  pool: WhirlpoolState,
  tickLower: number,
  tickUpper: number,
): { liquidityDelta: bigint; tokenMaxA: bigint; tokenMaxB: bigint; tokenEstA: bigint; tokenEstB: bigint } {
  const sqrtPriceLower = tickIndexToSqrtPrice(tickLower);
  const sqrtPriceUpper = tickIndexToSqrtPrice(tickUpper);
  const currentSqrtPrice = pool.sqrtPrice;

  let liquidity: bigint;
  let estA: bigint;
  let estB: bigint;

  if (currentSqrtPrice <= sqrtPriceLower) {
    // Current price is below range: all token A
    // Can't quote from B when price below range
    liquidity = 0n;
    estA = 0n;
    estB = 0n;
  } else if (currentSqrtPrice >= sqrtPriceUpper) {
    // Current price is above range: all token B
    liquidity = getLiquidityFromAmountB(sqrtPriceLower, sqrtPriceUpper, tokenAmountB);
    estA = 0n;
    estB = tokenAmountB;
  } else {
    // Price is within range: need both tokens
    liquidity = getLiquidityFromAmountB(sqrtPriceLower, currentSqrtPrice, tokenAmountB);
    estA = getAmountDeltaA(currentSqrtPrice, sqrtPriceUpper, liquidity, true);
    estB = tokenAmountB;
  }

  const slippageFactor = BigInt(10000 + slippageBps);
  const tokenMaxA = (estA * slippageFactor + 9999n) / 10000n;
  const tokenMaxB = (estB * slippageFactor + 9999n) / 10000n;

  return { liquidityDelta: liquidity, tokenMaxA, tokenMaxB, tokenEstA: estA, tokenEstB: estB };
}

/**
 * Compute the token amounts returned when removing liquidity.
 */
export function decreaseLiquidityQuote(
  liquidityDelta: bigint,
  slippageBps: number,
  pool: WhirlpoolState,
  tickLower: number,
  tickUpper: number,
): { tokenMinA: bigint; tokenMinB: bigint; tokenEstA: bigint; tokenEstB: bigint } {
  const sqrtPriceLower = tickIndexToSqrtPrice(tickLower);
  const sqrtPriceUpper = tickIndexToSqrtPrice(tickUpper);
  const currentSqrtPrice = pool.sqrtPrice;

  let estA: bigint;
  let estB: bigint;

  if (currentSqrtPrice <= sqrtPriceLower) {
    estA = getAmountDeltaA(sqrtPriceLower, sqrtPriceUpper, liquidityDelta, false);
    estB = 0n;
  } else if (currentSqrtPrice >= sqrtPriceUpper) {
    estA = 0n;
    estB = getAmountDeltaB(sqrtPriceLower, sqrtPriceUpper, liquidityDelta, false);
  } else {
    estA = getAmountDeltaA(currentSqrtPrice, sqrtPriceUpper, liquidityDelta, false);
    estB = getAmountDeltaB(sqrtPriceLower, currentSqrtPrice, liquidityDelta, false);
  }

  const slippageFactor = BigInt(10000 - slippageBps);
  const tokenMinA = (estA * slippageFactor) / 10000n;
  const tokenMinB = (estB * slippageFactor) / 10000n;

  return { tokenMinA, tokenMinB, tokenEstA: estA, tokenEstB: estB };
}

// ── Internal: compute liquidity from single token amount ───────────────────

function getLiquidityFromAmountA(
  sqrtPriceLower: bigint,
  sqrtPriceUpper: bigint,
  amount: bigint,
): bigint {
  // L = amount * sqrtPriceLower * sqrtPriceUpper / (Q64 * (sqrtPriceUpper - sqrtPriceLower))
  const numerator = amount * sqrtPriceLower * sqrtPriceUpper;
  const denominator = Q64 * (sqrtPriceUpper - sqrtPriceLower);
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

function getLiquidityFromAmountB(
  sqrtPriceLower: bigint,
  sqrtPriceUpper: bigint,
  amount: bigint,
): bigint {
  // L = amount * Q64 / (sqrtPriceUpper - sqrtPriceLower)
  const numerator = amount * Q64;
  const denominator = sqrtPriceUpper - sqrtPriceLower;
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}
