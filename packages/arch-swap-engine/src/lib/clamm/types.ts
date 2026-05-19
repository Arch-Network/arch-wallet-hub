// CLAMM-domain types. Whirlpool/Tick/Position layouts and the swap-quote
// result shape produced by `clamm/math/swap-math`.

export type WhirlpoolRewardInfo = {
  mint: Uint8Array;
  vault: Uint8Array;
  authority: Uint8Array;
  emissionsPerSecondX64: bigint;
  growthGlobalX64: bigint;
};

export type WhirlpoolState = {
  whirlpoolsConfig: Uint8Array;
  whirlpoolBump: number[];
  tickSpacing: number;
  tickSpacingSeed: number[];
  feeRate: number;
  protocolFeeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  protocolFeeOwedA: bigint;
  protocolFeeOwedB: bigint;
  tokenMintA: Uint8Array;
  tokenVaultA: Uint8Array;
  tokenMintB: Uint8Array;
  tokenVaultB: Uint8Array;
  feeGrowthGlobalA: bigint;
  feeGrowthGlobalB: bigint;
  rewardLastUpdatedTimestamp: bigint;
  rewardInfos: [WhirlpoolRewardInfo, WhirlpoolRewardInfo, WhirlpoolRewardInfo];
};

export type Tick = {
  initialized: boolean;
  liquidityNet: bigint;
  liquidityGross: bigint;
  feeGrowthOutsideA: bigint;
  feeGrowthOutsideB: bigint;
  rewardGrowthsOutside: [bigint, bigint, bigint];
};

export type TickArrayData = {
  startTickIndex: number;
  ticks: Tick[];
  whirlpool: Uint8Array;
};

export type PositionRewardInfo = {
  growthInsideCheckpoint: bigint;
  amountOwed: bigint;
};

export type PositionData = {
  whirlpool: Uint8Array;
  positionMint: Uint8Array;
  liquidity: bigint;
  tickLowerIndex: number;
  tickUpperIndex: number;
  feeGrowthCheckpointA: bigint;
  feeOwedA: bigint;
  feeGrowthCheckpointB: bigint;
  feeOwedB: bigint;
  rewardInfos: [PositionRewardInfo, PositionRewardInfo, PositionRewardInfo];
};

export type SwapQuote = {
  estimatedAmountIn: bigint;
  estimatedAmountOut: bigint;
  estimatedFeeAmount: bigint;
  amountSpecifiedIsInput: boolean;
  aToB: boolean;
  otherAmountThreshold: bigint;
  sqrtPriceLimit: bigint;
  tickArrays: TickArrayData[];
};
