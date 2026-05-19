import { FEE_RATE_MUL_VALUE, MIN_SQRT_PRICE, MAX_SQRT_PRICE, TICK_ARRAY_SIZE } from "@/lib/clamm/constants";
import { tickIndexToSqrtPrice } from "@/lib/clamm/math/tick-math";
import {
  getAmountDeltaA,
  getAmountDeltaB,
  getNextSqrtPriceFromA,
  getNextSqrtPriceFromB,
} from "@/lib/clamm/math/token-math";
import type { WhirlpoolState, TickArrayData, SwapQuote, Tick } from "@/lib/clamm/types";

// ── Single swap step computation ───────────────────────────────────────────

export type SwapStepResult = {
  nextSqrtPrice: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
};

/**
 * Compute a single swap step between current price and a target tick price.
 */
export function computeSwapStep(
  amountRemaining: bigint,
  feeRate: number,
  currentLiquidity: bigint,
  currentSqrtPrice: bigint,
  targetSqrtPrice: bigint,
  aToB: boolean,
  amountSpecifiedIsInput: boolean,
): SwapStepResult {
  // If no liquidity, we can only move to the target price
  if (currentLiquidity === 0n) {
    return {
      nextSqrtPrice: targetSqrtPrice,
      amountIn: 0n,
      amountOut: 0n,
      feeAmount: 0n,
    };
  }

  // Deduct fee from input amount if specified as input
  let amountCalc = amountRemaining;
  if (amountSpecifiedIsInput) {
    const feeDeduction = (amountRemaining * BigInt(feeRate)) / BigInt(FEE_RATE_MUL_VALUE);
    amountCalc = amountRemaining - feeDeduction;
  }

  // Determine if we can reach the target price
  let nextSqrtPrice: bigint;
  const amountToTarget = aToB
    ? getAmountDeltaA(targetSqrtPrice, currentSqrtPrice, currentLiquidity, amountSpecifiedIsInput)
    : getAmountDeltaB(currentSqrtPrice, targetSqrtPrice, currentLiquidity, amountSpecifiedIsInput);

  if (amountSpecifiedIsInput ? amountCalc >= amountToTarget : amountCalc >= amountToTarget) {
    // We reach the target price
    nextSqrtPrice = targetSqrtPrice;
  } else {
    // We exhaust the amount before reaching target
    nextSqrtPrice = aToB
      ? getNextSqrtPriceFromA(currentSqrtPrice, currentLiquidity, amountCalc, amountSpecifiedIsInput)
      : getNextSqrtPriceFromB(currentSqrtPrice, currentLiquidity, amountCalc, amountSpecifiedIsInput);
  }

  const reachedTarget = nextSqrtPrice === targetSqrtPrice;

  // Calculate actual amounts based on direction
  let amountIn: bigint;
  let amountOut: bigint;

  if (aToB) {
    amountIn = reachedTarget && amountSpecifiedIsInput
      ? amountToTarget
      : getAmountDeltaA(nextSqrtPrice, currentSqrtPrice, currentLiquidity, true);
    amountOut = reachedTarget && !amountSpecifiedIsInput
      ? amountToTarget
      : getAmountDeltaB(nextSqrtPrice, currentSqrtPrice, currentLiquidity, false);
  } else {
    amountIn = reachedTarget && amountSpecifiedIsInput
      ? amountToTarget
      : getAmountDeltaB(currentSqrtPrice, nextSqrtPrice, currentLiquidity, true);
    amountOut = reachedTarget && !amountSpecifiedIsInput
      ? amountToTarget
      : getAmountDeltaA(currentSqrtPrice, nextSqrtPrice, currentLiquidity, false);
  }

  // Cap output at remaining amount for exact-out
  if (!amountSpecifiedIsInput && amountOut > amountRemaining) {
    amountOut = amountRemaining;
  }

  // Calculate fee
  let feeAmount: bigint;
  if (amountSpecifiedIsInput && !reachedTarget) {
    feeAmount = amountRemaining - amountIn;
  } else {
    feeAmount = (amountIn * BigInt(feeRate) + BigInt(FEE_RATE_MUL_VALUE) - 1n) / BigInt(FEE_RATE_MUL_VALUE);
  }

  return { nextSqrtPrice, amountIn, amountOut, feeAmount };
}

// ── Full swap simulation ───────────────────────────────────────────────────

type TickWithIndex = {
  tick: Tick;
  tickIndex: number;
};

function getNextInitializedTick(
  tickArrays: TickArrayData[],
  currentTickIndex: number,
  tickSpacing: number,
  aToB: boolean,
): TickWithIndex | null {
  for (const tickArray of tickArrays) {
    const startIndex = tickArray.startTickIndex;
    const endIndex = startIndex + TICK_ARRAY_SIZE * tickSpacing;

    if (aToB) {
      // Search from current tick downward
      for (let i = TICK_ARRAY_SIZE - 1; i >= 0; i--) {
        const tickIndex = startIndex + i * tickSpacing;
        if (tickIndex <= currentTickIndex && tickArray.ticks[i].initialized) {
          return { tick: tickArray.ticks[i], tickIndex };
        }
      }
    } else {
      // Search from current tick upward
      for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
        const tickIndex = startIndex + i * tickSpacing;
        if (tickIndex > currentTickIndex && tickArray.ticks[i].initialized) {
          return { tick: tickArray.ticks[i], tickIndex };
        }
      }
    }
  }
  return null;
}

export type SwapResult = {
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
  nextSqrtPrice: bigint;
  nextTickIndex: number;
};

/**
 * Simulate a full swap across tick arrays.
 */
export function computeSwap(
  tokenAmount: bigint,
  sqrtPriceLimit: bigint,
  pool: WhirlpoolState,
  tickArrays: TickArrayData[],
  aToB: boolean,
  amountSpecifiedIsInput: boolean,
): SwapResult {
  let amountRemaining = tokenAmount;
  let totalAmountIn = 0n;
  let totalAmountOut = 0n;
  let totalFeeAmount = 0n;
  let currentSqrtPrice = pool.sqrtPrice;
  let currentTickIndex = pool.tickCurrentIndex;
  let currentLiquidity = pool.liquidity;

  while (amountRemaining > 0n) {
    // Find next initialized tick
    const nextTick = getNextInitializedTick(
      tickArrays,
      currentTickIndex,
      pool.tickSpacing,
      aToB,
    );

    // Determine target sqrt price for this step
    let targetSqrtPrice: bigint;
    if (nextTick) {
      targetSqrtPrice = tickIndexToSqrtPrice(nextTick.tickIndex);
    } else {
      targetSqrtPrice = aToB ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
    }

    // Clamp to price limit
    if (aToB) {
      if (targetSqrtPrice < sqrtPriceLimit) targetSqrtPrice = sqrtPriceLimit;
    } else {
      if (targetSqrtPrice > sqrtPriceLimit) targetSqrtPrice = sqrtPriceLimit;
    }

    // Compute swap step
    const step = computeSwapStep(
      amountRemaining,
      pool.feeRate,
      currentLiquidity,
      currentSqrtPrice,
      targetSqrtPrice,
      aToB,
      amountSpecifiedIsInput,
    );

    totalAmountIn += step.amountIn;
    totalAmountOut += step.amountOut;
    totalFeeAmount += step.feeAmount;

    if (amountSpecifiedIsInput) {
      amountRemaining -= step.amountIn + step.feeAmount;
    } else {
      amountRemaining -= step.amountOut;
    }

    currentSqrtPrice = step.nextSqrtPrice;

    // Check if we hit the price limit
    if (currentSqrtPrice === sqrtPriceLimit) break;

    // If we crossed a tick, update liquidity
    if (nextTick && step.nextSqrtPrice === tickIndexToSqrtPrice(nextTick.tickIndex)) {
      if (aToB) {
        currentLiquidity -= nextTick.tick.liquidityNet;
        currentTickIndex = nextTick.tickIndex - 1;
      } else {
        currentLiquidity += nextTick.tick.liquidityNet;
        currentTickIndex = nextTick.tickIndex;
      }
    } else {
      // Didn't reach next tick, we're done
      break;
    }
  }

  return {
    amountIn: totalAmountIn,
    amountOut: totalAmountOut,
    feeAmount: totalFeeAmount,
    nextSqrtPrice: currentSqrtPrice,
    nextTickIndex: currentTickIndex,
  };
}

// ── High-level quote functions ─────────────────────────────────────────────

/**
 * Get a swap quote for an exact input amount.
 */
export function swapQuoteByInputToken(
  tokenIn: bigint,
  aToB: boolean,
  slippageBps: number,
  pool: WhirlpoolState,
  tickArrays: TickArrayData[],
): SwapQuote {
  const sqrtPriceLimit = aToB ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;

  const result = computeSwap(tokenIn, sqrtPriceLimit, pool, tickArrays, aToB, true);

  // Apply slippage tolerance to output amount
  const slippageFactor = BigInt(10000 - slippageBps);
  const otherAmountThreshold = (result.amountOut * slippageFactor) / 10000n;

  return {
    estimatedAmountIn: result.amountIn + result.feeAmount,
    estimatedAmountOut: result.amountOut,
    estimatedFeeAmount: result.feeAmount,
    amountSpecifiedIsInput: true,
    aToB,
    otherAmountThreshold,
    sqrtPriceLimit,
    tickArrays,
  };
}

