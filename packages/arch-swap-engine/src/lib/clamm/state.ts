import {
  decodeBool,
  decodeI32LE,
  decodeI128LE,
  decodePubkey,
  decodeU64LE,
  decodeU128LE,
} from "@/lib/arch/borsh";
import { NUM_REWARDS, TICK_ARRAY_SIZE, TICK_SIZE } from "@/lib/clamm/constants";
import type {
  WhirlpoolState,
  WhirlpoolRewardInfo,
  TickArrayData,
  Tick,
  PositionData,
  PositionRewardInfo,
} from "@/lib/clamm/types";

// ── Anchor discriminator (first 8 bytes) ───────────────────────────────────

const ANCHOR_DISCRIMINATOR_SIZE = 8;

// ── Whirlpool deserialization ──────────────────────────────────────────────

function deserializeRewardInfo(data: Uint8Array, offset: number): { info: WhirlpoolRewardInfo; bytesRead: number } {
  let pos = offset;
  const mint = decodePubkey(data, pos); pos += 32;
  const vault = decodePubkey(data, pos); pos += 32;
  const authority = decodePubkey(data, pos); pos += 32;
  const emissionsPerSecondX64 = decodeU128LE(data, pos); pos += 16;
  const growthGlobalX64 = decodeU128LE(data, pos); pos += 16;

  return {
    info: { mint, vault, authority, emissionsPerSecondX64, growthGlobalX64 },
    bytesRead: pos - offset,
  };
}

export function deserializeWhirlpool(data: Uint8Array): WhirlpoolState {
  let pos = ANCHOR_DISCRIMINATOR_SIZE; // skip 8-byte discriminator

  const whirlpoolsConfig = decodePubkey(data, pos); pos += 32;
  const whirlpoolBump = [data[pos]]; pos += 1;
  const tickSpacing = data[pos] | (data[pos + 1] << 8); pos += 2;
  const tickSpacingSeed = [data[pos], data[pos + 1]]; pos += 2;
  const feeRate = data[pos] | (data[pos + 1] << 8); pos += 2;
  const protocolFeeRate = data[pos] | (data[pos + 1] << 8); pos += 2;
  const liquidity = decodeU128LE(data, pos); pos += 16;
  const sqrtPrice = decodeU128LE(data, pos); pos += 16;
  const tickCurrentIndex = decodeI32LE(data, pos); pos += 4;
  const protocolFeeOwedA = decodeU64LE(data, pos); pos += 8;
  const protocolFeeOwedB = decodeU64LE(data, pos); pos += 8;
  const tokenMintA = decodePubkey(data, pos); pos += 32;
  const tokenVaultA = decodePubkey(data, pos); pos += 32;
  const feeGrowthGlobalA = decodeU128LE(data, pos); pos += 16;
  const tokenMintB = decodePubkey(data, pos); pos += 32;
  const tokenVaultB = decodePubkey(data, pos); pos += 32;
  const feeGrowthGlobalB = decodeU128LE(data, pos); pos += 16;
  const rewardLastUpdatedTimestamp = decodeU64LE(data, pos); pos += 8;

  const rewardInfos: WhirlpoolRewardInfo[] = [];
  for (let i = 0; i < NUM_REWARDS; i++) {
    const { info, bytesRead } = deserializeRewardInfo(data, pos);
    rewardInfos.push(info);
    pos += bytesRead;
  }

  return {
    whirlpoolsConfig,
    whirlpoolBump,
    tickSpacing,
    tickSpacingSeed,
    feeRate,
    protocolFeeRate,
    liquidity,
    sqrtPrice,
    tickCurrentIndex,
    protocolFeeOwedA,
    protocolFeeOwedB,
    tokenMintA,
    tokenVaultA,
    tokenMintB,
    tokenVaultB,
    feeGrowthGlobalA,
    feeGrowthGlobalB,
    rewardLastUpdatedTimestamp,
    rewardInfos: rewardInfos as [WhirlpoolRewardInfo, WhirlpoolRewardInfo, WhirlpoolRewardInfo],
  };
}

// ── Tick array deserialization ─────────────────────────────────────────────

function deserializeTick(data: Uint8Array, offset: number): Tick {
  let pos = offset;

  const initialized = decodeBool(data, pos); pos += 1;
  const liquidityNet = decodeI128LE(data, pos); pos += 16;
  const liquidityGross = decodeU128LE(data, pos); pos += 16;
  const feeGrowthOutsideA = decodeU128LE(data, pos); pos += 16;
  const feeGrowthOutsideB = decodeU128LE(data, pos); pos += 16;

  const rewardGrowthsOutside: [bigint, bigint, bigint] = [0n, 0n, 0n];
  for (let i = 0; i < NUM_REWARDS; i++) {
    rewardGrowthsOutside[i] = decodeU128LE(data, pos);
    pos += 16;
  }

  return {
    initialized,
    liquidityNet,
    liquidityGross,
    feeGrowthOutsideA,
    feeGrowthOutsideB,
    rewardGrowthsOutside,
  };
}

export function deserializeTickArray(data: Uint8Array): TickArrayData {
  let pos = ANCHOR_DISCRIMINATOR_SIZE; // skip 8-byte discriminator

  const startTickIndex = decodeI32LE(data, pos); pos += 4;

  const ticks: Tick[] = [];
  for (let i = 0; i < TICK_ARRAY_SIZE; i++) {
    ticks.push(deserializeTick(data, pos));
    pos += TICK_SIZE;
  }

  const whirlpool = decodePubkey(data, pos);

  return { startTickIndex, ticks, whirlpool };
}

// ── Position deserialization ───────────────────────────────────────────────

function deserializePositionRewardInfo(data: Uint8Array, offset: number): { info: PositionRewardInfo; bytesRead: number } {
  let pos = offset;
  const growthInsideCheckpoint = decodeU128LE(data, pos); pos += 16;
  const amountOwed = decodeU64LE(data, pos); pos += 8;

  return {
    info: { growthInsideCheckpoint, amountOwed },
    bytesRead: pos - offset,
  };
}

export function deserializePosition(data: Uint8Array): PositionData {
  let pos = ANCHOR_DISCRIMINATOR_SIZE; // skip 8-byte discriminator

  const whirlpool = decodePubkey(data, pos); pos += 32;
  const positionMint = decodePubkey(data, pos); pos += 32;
  const liquidity = decodeU128LE(data, pos); pos += 16;
  const tickLowerIndex = decodeI32LE(data, pos); pos += 4;
  const tickUpperIndex = decodeI32LE(data, pos); pos += 4;
  const feeGrowthCheckpointA = decodeU128LE(data, pos); pos += 16;
  const feeOwedA = decodeU64LE(data, pos); pos += 8;
  const feeGrowthCheckpointB = decodeU128LE(data, pos); pos += 16;
  const feeOwedB = decodeU64LE(data, pos); pos += 8;

  const rewardInfos: PositionRewardInfo[] = [];
  for (let i = 0; i < NUM_REWARDS; i++) {
    const { info, bytesRead } = deserializePositionRewardInfo(data, pos);
    rewardInfos.push(info);
    pos += bytesRead;
  }

  return {
    whirlpool,
    positionMint,
    liquidity,
    tickLowerIndex,
    tickUpperIndex,
    feeGrowthCheckpointA,
    feeOwedA,
    feeGrowthCheckpointB,
    feeOwedB,
    rewardInfos: rewardInfos as [PositionRewardInfo, PositionRewardInfo, PositionRewardInfo],
  };
}
