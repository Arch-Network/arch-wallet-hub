import { PubkeyUtil } from "@saturnbtcio/arch-sdk";

import { encodeU16LE } from "@/lib/arch/borsh";
import { TICK_ARRAY_SIZE } from "@/lib/clamm/constants";

function textSeed(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function deriveWhirlpoolAddress(
  programId: Uint8Array,
  config: Uint8Array,
  mintA: Uint8Array,
  mintB: Uint8Array,
  tickSpacing: number,
): [Uint8Array, number] {
  const seeds = [
    textSeed("whirlpool"),
    config,
    mintA,
    mintB,
    Uint8Array.from(encodeU16LE(tickSpacing)),
  ];
  return PubkeyUtil.findProgramAddress(seeds, programId);
}

export function deriveTickArrayAddress(
  programId: Uint8Array,
  whirlpool: Uint8Array,
  startTickIndex: number,
): Uint8Array {
  const seeds = [
    textSeed("tick_array"),
    whirlpool,
    new TextEncoder().encode(startTickIndex.toString()),
  ];
  return PubkeyUtil.findProgramAddress(seeds, programId)[0];
}

export function derivePositionAddress(
  programId: Uint8Array,
  positionMint: Uint8Array,
): [Uint8Array, number] {
  const seeds = [textSeed("position"), positionMint];
  return PubkeyUtil.findProgramAddress(seeds, programId);
}

export function deriveOracleAddress(
  programId: Uint8Array,
  whirlpool: Uint8Array,
): Uint8Array {
  const seeds = [textSeed("oracle"), whirlpool];
  return PubkeyUtil.findProgramAddress(seeds, programId)[0];
}

export function deriveFeeTierAddress(
  programId: Uint8Array,
  config: Uint8Array,
  tickSpacing: number,
): Uint8Array {
  const seeds = [
    textSeed("fee_tier"),
    config,
    Uint8Array.from(encodeU16LE(tickSpacing)),
  ];
  return PubkeyUtil.findProgramAddress(seeds, programId)[0];
}

export function getStartTickIndex(
  tickIndex: number,
  tickSpacing: number,
  offset = 0,
): number {
  const arraySpan = tickSpacing * TICK_ARRAY_SIZE;
  const startTickIndex =
    tickIndex - ((tickIndex % arraySpan + arraySpan) % arraySpan);
  return startTickIndex + offset * arraySpan;
}

export function getTickArrayAddresses(
  programId: Uint8Array,
  whirlpool: Uint8Array,
  currentTickIndex: number,
  tickSpacing: number,
  aToB: boolean,
): [Uint8Array, Uint8Array, Uint8Array] {
  const direction = aToB ? -1 : 1;
  const start0 = getStartTickIndex(currentTickIndex, tickSpacing, 0);
  const start1 = getStartTickIndex(currentTickIndex, tickSpacing, direction);
  const start2 = getStartTickIndex(currentTickIndex, tickSpacing, direction * 2);

  return [
    deriveTickArrayAddress(programId, whirlpool, start0),
    deriveTickArrayAddress(programId, whirlpool, start1),
    deriveTickArrayAddress(programId, whirlpool, start2),
  ];
}

export function getSwapTickArrayAddresses(
  programId: Uint8Array,
  whirlpool: Uint8Array,
  currentTickIndex: number,
  tickSpacing: number,
): [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array] {
  const start0 = getStartTickIndex(currentTickIndex, tickSpacing, 0);
  const startPlus1 = getStartTickIndex(currentTickIndex, tickSpacing, 1);
  const startPlus2 = getStartTickIndex(currentTickIndex, tickSpacing, 2);
  const startMinus1 = getStartTickIndex(currentTickIndex, tickSpacing, -1);
  const startMinus2 = getStartTickIndex(currentTickIndex, tickSpacing, -2);

  return [
    deriveTickArrayAddress(programId, whirlpool, start0),
    deriveTickArrayAddress(programId, whirlpool, startPlus1),
    deriveTickArrayAddress(programId, whirlpool, startPlus2),
    deriveTickArrayAddress(programId, whirlpool, startMinus1),
    deriveTickArrayAddress(programId, whirlpool, startMinus2),
  ];
}
