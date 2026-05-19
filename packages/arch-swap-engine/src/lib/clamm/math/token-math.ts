// ── Token amount math for concentrated liquidity ───────────────────────────
// All calculations use bigint for precision. Intermediate results may need
// up to 256 bits, which we handle with bigint (no size limit in JS).

const Q64 = 1n << 64n;

/**
 * Computes the amount of token A for a given liquidity and price range.
 * deltaA = L * (1/sqrtPriceLower - 1/sqrtPriceUpper)
 *        = L * (sqrtPriceUpper - sqrtPriceLower) / (sqrtPriceLower * sqrtPriceUpper)
 * All sqrt prices are in Q64.64 format.
 */
export function getAmountDeltaA(
  sqrtPriceLower: bigint,
  sqrtPriceUpper: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  if (sqrtPriceLower > sqrtPriceUpper) {
    [sqrtPriceLower, sqrtPriceUpper] = [sqrtPriceUpper, sqrtPriceLower];
  }

  const numerator = liquidity * (sqrtPriceUpper - sqrtPriceLower);
  const denominator = sqrtPriceLower * sqrtPriceUpper;

  if (denominator === 0n) return 0n;

  // Shift by Q64 since sqrt prices are in Q64.64
  const shifted = numerator * Q64;

  if (roundUp) {
    return (shifted + denominator - 1n) / denominator;
  }
  return shifted / denominator;
}

/**
 * Computes the amount of token B for a given liquidity and price range.
 * deltaB = L * (sqrtPriceUpper - sqrtPriceLower)
 * All sqrt prices are in Q64.64 format.
 */
export function getAmountDeltaB(
  sqrtPriceLower: bigint,
  sqrtPriceUpper: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  if (sqrtPriceLower > sqrtPriceUpper) {
    [sqrtPriceLower, sqrtPriceUpper] = [sqrtPriceUpper, sqrtPriceLower];
  }

  const product = liquidity * (sqrtPriceUpper - sqrtPriceLower);

  if (roundUp) {
    return (product + Q64 - 1n) / Q64;
  }
  return product / Q64;
}

/**
 * Given current sqrt price, liquidity, and token A input/output amount,
 * compute the next sqrt price.
 *
 * When amountSpecifiedIsInput (exact in):
 *   nextSqrtPrice = sqrtPrice * L / (L + amount * sqrtPrice)
 * When !amountSpecifiedIsInput (exact out):
 *   nextSqrtPrice = sqrtPrice * L / (L - amount * sqrtPrice)
 */
export function getNextSqrtPriceFromA(
  sqrtPrice: bigint,
  liquidity: bigint,
  amount: bigint,
  amountSpecifiedIsInput: boolean,
): bigint {
  if (amount === 0n) return sqrtPrice;

  // numerator = L * sqrtPrice (Q64.64 * Q0 = Q64.64 shifted)
  const numerator = liquidity * sqrtPrice;

  // product = amount * sqrtPrice / Q64 (amount in tokens, sqrtPrice in Q64.64)
  const product = (amount * sqrtPrice) / Q64;

  if (amountSpecifiedIsInput) {
    // nextSqrt = L * sqrtPrice / (L + amount * sqrtPrice / Q64)
    const denominator = liquidity + product;
    if (denominator === 0n) return 0n;
    return (numerator + denominator - 1n) / denominator; // round up
  } else {
    // nextSqrt = L * sqrtPrice / (L - amount * sqrtPrice / Q64)
    if (liquidity <= product) {
      throw new Error("Insufficient liquidity for exact output");
    }
    const denominator = liquidity - product;
    return (numerator + denominator - 1n) / denominator; // round up
  }
}

/**
 * Given current sqrt price, liquidity, and token B input/output amount,
 * compute the next sqrt price.
 *
 * When amountSpecifiedIsInput:
 *   nextSqrtPrice = sqrtPrice + amount * Q64 / L
 * When !amountSpecifiedIsInput:
 *   nextSqrtPrice = sqrtPrice - amount * Q64 / L
 */
export function getNextSqrtPriceFromB(
  sqrtPrice: bigint,
  liquidity: bigint,
  amount: bigint,
  amountSpecifiedIsInput: boolean,
): bigint {
  if (amount === 0n) return sqrtPrice;
  if (liquidity === 0n) throw new Error("Zero liquidity");

  const quotient = (amount * Q64) / liquidity;

  if (amountSpecifiedIsInput) {
    return sqrtPrice + quotient;
  } else {
    if (sqrtPrice <= quotient) {
      throw new Error("Sqrt price underflow");
    }
    return sqrtPrice - quotient;
  }
}
