import { PubkeyUtil } from "@saturnbtcio/arch-sdk";

import { POSITION_ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from "@/lib/clamm/constants";
import { hexToBase58 } from "@/lib/arch/base58";
import {
  fetchAccountData,
  fetchAccountInfo,
  fetchProgramAccounts,
} from "@/lib/indexer/accounts";
import { fetchTokenAccountBalance } from "@/lib/indexer/balances";
import { IndexerRpcError } from "@/lib/indexer/client";
import { hexToBytes, bytesToHex } from "@/lib/arch/hex";
import { buildTransaction } from "@/lib/arch/tx-builder";
import type { RuntimeTransaction } from "@/lib/arch/types";
import type {
  WhirlpoolState,
  TickArrayData,
  PositionData,
  SwapQuote,
} from "@/lib/clamm/types";
import {
  deserializePosition,
  deserializeTickArray,
  deserializeWhirlpool,
} from "@/lib/clamm/state";
import {
  deriveTickArrayAddress,
  deriveOracleAddress,
  derivePositionAddress,
  deriveFeeTierAddress,
  deriveWhirlpoolAddress,
  getStartTickIndex,
  getSwapTickArrayAddresses,
  getTickArrayAddresses,
} from "@/lib/clamm/pda";
import { swapQuoteByInputToken } from "@/lib/clamm/math/swap-math";
import {
  buildSwapV2Instruction,
  buildInitializeConfigInstruction,
  buildInitializeFeeTierInstruction,
  buildInitializePoolInstruction,
  buildInitializeTickArrayInstruction,
  buildOpenPositionInstruction,
  buildIncreaseLiquidityInstruction,
  buildDecreaseLiquidityInstruction,
  buildCollectFeesInstruction,
  buildClosePositionInstruction,
} from "@/lib/clamm/instructions";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@/lib/arch/program-ids";
import {
  getClammProgramIdBytes,
  type NetworkConfig,
} from "@/lib/network/config";

function isAccountNotFound(err: unknown): boolean {
  return err instanceof IndexerRpcError && err.code === -32002;
}

export async function fetchWhirlpoolState(
  poolAddress: Uint8Array,
): Promise<WhirlpoolState> {
  const data = await fetchAccountData(poolAddress);
  return deserializeWhirlpool(data);
}

export async function fetchTickArrays(
  config: NetworkConfig,
  whirlpool: Uint8Array,
  currentTickIndex: number,
  aToB: boolean,
  tickSpacing: number,
): Promise<TickArrayData[]> {
  const programId = getClammProgramIdBytes(config);
  const [addr0, addr1, addr2] = getTickArrayAddresses(
    programId,
    whirlpool,
    currentTickIndex,
    tickSpacing,
    aToB,
  );

  const safeFetch = (addr: Uint8Array) =>
    fetchAccountInfo(addr).catch((err) => {
      if (isAccountNotFound(err)) return null;
      throw err;
    });

  const infos = await Promise.all([
    safeFetch(addr0),
    safeFetch(addr1),
    safeFetch(addr2),
  ]);

  const results: TickArrayData[] = [];
  for (const info of infos) {
    if (info) results.push(deserializeTickArray(new Uint8Array(info.data)));
  }
  return results;
}

export async function fetchPosition(
  config: NetworkConfig,
  positionMint: Uint8Array,
): Promise<PositionData> {
  const programId = getClammProgramIdBytes(config);
  const [positionAddress] = derivePositionAddress(programId, positionMint);
  const data = await fetchAccountData(positionAddress);
  return deserializePosition(data);
}

export async function fetchUserPositions(
  config: NetworkConfig,
  userPubkey: Uint8Array,
): Promise<(PositionData & { positionMintHex: string })[]> {
  const programId = getClammProgramIdBytes(config);
  const tokenAccounts = await fetchProgramAccounts(TOKEN_PROGRAM_ID, [
    { DataContent: { offset: 32, bytes: Array.from(userPubkey) } },
  ]);

  const positions: (PositionData & { positionMintHex: string })[] = [];

  for (const { account } of tokenAccounts) {
    const data = new Uint8Array(account.data);
    if (data.length < 72) continue;

    let amount = 0n;
    for (let i = 0; i < 8; i += 1) {
      amount |= BigInt(data[64 + i]) << BigInt(i * 8);
    }
    if (amount !== 1n) continue;

    const mint = data.slice(0, 32);
    const [positionAddress] = derivePositionAddress(programId, mint);

    try {
      const info = await fetchAccountInfo(positionAddress);
      if (!info) continue;
      const posData = new Uint8Array(info.data);
      if (posData.length < POSITION_ACCOUNT_SIZE) continue;
      const position = deserializePosition(posData);
      const mintHex = Array.from(mint)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      positions.push({ ...position, positionMintHex: mintHex });
    } catch {
      // Not a CLAMM position — skip.
    }
  }

  return positions;
}

export async function fetchAllPoolPositions(
  config: NetworkConfig,
  poolAddress: Uint8Array,
): Promise<PositionData[]> {
  const programId = getClammProgramIdBytes(config);
  const accounts = await fetchProgramAccounts(programId, [
    { DataContent: { offset: 8, bytes: Array.from(poolAddress) } },
  ]);

  const positions: PositionData[] = [];

  for (const { account } of accounts) {
    const data = new Uint8Array(account.data);
    if (data.length !== POSITION_ACCOUNT_SIZE) continue;

    try {
      const position = deserializePosition(data);
      if (position.liquidity === 0n) continue;
      positions.push(position);
    } catch {
      // Not a valid position — skip.
    }
  }

  return positions;
}

export async function fetchVaultBalances(
  pool: WhirlpoolState,
): Promise<{ tokenA: bigint; tokenB: bigint }> {
  const vaultAArchAddress = hexToBase58(bytesToHex(pool.tokenVaultA));
  const vaultBArchAddress = hexToBase58(bytesToHex(pool.tokenVaultB));

  const [tokenA, tokenB] = await Promise.all([
    fetchTokenAccountBalance(vaultAArchAddress),
    fetchTokenAccountBalance(vaultBArchAddress),
  ]);

  if (tokenA === null) {
    throw new Error(`Pool vault A (${vaultAArchAddress}) not indexed`);
  }
  if (tokenB === null) {
    throw new Error(`Pool vault B (${vaultBArchAddress}) not indexed`);
  }

  return { tokenA, tokenB };
}

export async function getSwapQuote(
  config: NetworkConfig,
  poolAddress: Uint8Array,
  tokenIn: bigint,
  aToB: boolean,
  slippageBps: number,
): Promise<SwapQuote> {
  const pool = await fetchWhirlpoolState(poolAddress);
  const tickArrays = await fetchTickArrays(
    config,
    poolAddress,
    pool.tickCurrentIndex,
    aToB,
    pool.tickSpacing,
  );

  return swapQuoteByInputToken(tokenIn, aToB, slippageBps, pool, tickArrays);
}

export async function buildSwapTransaction(
  config: NetworkConfig,
  userPubkey: Uint8Array,
  poolAddress: Uint8Array,
  quote: SwapQuote,
  pool: WhirlpoolState,
): Promise<RuntimeTransaction> {
  const programId = getClammProgramIdBytes(config);
  const userAtaA = PubkeyUtil.getAssociatedTokenAddress(
    pool.tokenMintA,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userAtaB = PubkeyUtil.getAssociatedTokenAddress(
    pool.tokenMintB,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const [addrCurrent, addrPlus1, addrPlus2, addrMinus1, addrMinus2] =
    getSwapTickArrayAddresses(
      programId,
      poolAddress,
      pool.tickCurrentIndex,
      pool.tickSpacing,
    );

  const oracle = deriveOracleAddress(programId, poolAddress);

  const amount = quote.amountSpecifiedIsInput
    ? quote.estimatedAmountIn
    : quote.estimatedAmountOut;

  const instruction = await buildSwapV2Instruction(programId, {
    tokenAuthority: userPubkey,
    whirlpool: poolAddress,
    tokenMintA: pool.tokenMintA,
    tokenMintB: pool.tokenMintB,
    tokenOwnerAccountA: userAtaA,
    tokenVaultA: pool.tokenVaultA,
    tokenOwnerAccountB: userAtaB,
    tokenVaultB: pool.tokenVaultB,
    tickArray0: addrCurrent,
    tickArray1: addrPlus1,
    tickArray2: addrPlus2,
    oracle,
    supplementalTickArrays: [addrMinus1, addrMinus2],
    amount,
    otherAmountThreshold: quote.otherAmountThreshold,
    sqrtPriceLimit: 0n,
    amountSpecifiedIsInput: quote.amountSpecifiedIsInput,
    aToB: quote.aToB,
  });

  return buildTransaction([instruction], userPubkey);
}

export async function buildInitializeConfigTransaction(
  config: NetworkConfig,
  userPubkey: Uint8Array,
  clammConfigPubkey: Uint8Array,
  authorities: {
    feeAuthority: Uint8Array;
    collectProtocolFeesAuthority: Uint8Array;
    rewardEmissionsSuperAuthority: Uint8Array;
  },
  defaultProtocolFeeRate: number,
): Promise<RuntimeTransaction> {
  const programId = getClammProgramIdBytes(config);
  const instruction = await buildInitializeConfigInstruction(programId, {
    config: clammConfigPubkey,
    funder: userPubkey,
    feeAuthority: authorities.feeAuthority,
    collectProtocolFeesAuthority: authorities.collectProtocolFeesAuthority,
    rewardEmissionsSuperAuthority: authorities.rewardEmissionsSuperAuthority,
    defaultProtocolFeeRate,
  });

  return buildTransaction([instruction], userPubkey);
}

export async function buildInitializeFeeTierTransaction(
  config: NetworkConfig,
  userPubkey: Uint8Array,
  clammConfigPubkey: Uint8Array,
  tickSpacing: number,
  defaultFeeRate: number,
): Promise<RuntimeTransaction> {
  const programId = getClammProgramIdBytes(config);
  const feeTier = deriveFeeTierAddress(programId, clammConfigPubkey, tickSpacing);

  const instruction = await buildInitializeFeeTierInstruction(programId, {
    config: clammConfigPubkey,
    feeTier,
    funder: userPubkey,
    feeAuthority: userPubkey,
    tickSpacing,
    defaultFeeRate,
  });

  return buildTransaction([instruction], userPubkey);
}

export async function buildInitializePoolTransaction(
  config: NetworkConfig,
  userPubkey: Uint8Array,
  clammConfigPubkey: Uint8Array,
  mintA: Uint8Array,
  mintB: Uint8Array,
  tickSpacing: number,
  initialSqrtPrice: bigint,
  vaultA: Uint8Array,
  vaultB: Uint8Array,
): Promise<RuntimeTransaction> {
  const programId = getClammProgramIdBytes(config);
  const [whirlpool, whirlpoolBump] = deriveWhirlpoolAddress(
    programId,
    clammConfigPubkey,
    mintA,
    mintB,
    tickSpacing,
  );
  const feeTier = deriveFeeTierAddress(programId, clammConfigPubkey, tickSpacing);

  const instruction = await buildInitializePoolInstruction(programId, {
    whirlpoolsConfig: clammConfigPubkey,
    tokenMintA: mintA,
    tokenMintB: mintB,
    funder: userPubkey,
    whirlpool,
    whirlpoolBump,
    tokenVaultA: vaultA,
    tokenVaultB: vaultB,
    feeTier,
    tickSpacing,
    initialSqrtPrice,
  });

  return buildTransaction([instruction], userPubkey);
}

export async function buildInitializeTickArrayTransaction(
  config: NetworkConfig,
  userPubkey: Uint8Array,
  whirlpool: Uint8Array,
  startTickIndex: number,
): Promise<RuntimeTransaction> {
  const programId = getClammProgramIdBytes(config);
  const tickArray = deriveTickArrayAddress(programId, whirlpool, startTickIndex);

  const instruction = await buildInitializeTickArrayInstruction(programId, {
    whirlpool,
    funder: userPubkey,
    tickArray,
    startTickIndex,
  });

  return buildTransaction([instruction], userPubkey);
}

export async function ensureTickArrays(
  config: NetworkConfig,
  userPubkey: Uint8Array,
  whirlpool: Uint8Array,
  tickSpacing: number,
  tickLowerIndex: number,
  tickUpperIndex: number,
): Promise<RuntimeTransaction | null> {
  const programId = getClammProgramIdBytes(config);
  const neededStarts = new Set<number>();
  neededStarts.add(getStartTickIndex(tickLowerIndex, tickSpacing));
  neededStarts.add(getStartTickIndex(tickUpperIndex, tickSpacing));

  const missingStarts: number[] = [];

  for (const startIndex of neededStarts) {
    const addr = deriveTickArrayAddress(programId, whirlpool, startIndex);
    const info = await fetchAccountInfo(addr).catch((err) => {
      if (err instanceof IndexerRpcError && err.code === -32002) return null;
      throw err;
    });
    if (!info) missingStarts.push(startIndex);
  }

  if (missingStarts.length === 0) return null;

  const instructions = await Promise.all(
    missingStarts.map((startIndex) => {
      const tickArray = deriveTickArrayAddress(programId, whirlpool, startIndex);
      return buildInitializeTickArrayInstruction(programId, {
        whirlpool,
        funder: userPubkey,
        tickArray,
        startTickIndex: startIndex,
      });
    }),
  );

  return buildTransaction(instructions, userPubkey);
}

export async function buildOpenPositionTransaction(
  config: NetworkConfig,
  userPubkey: Uint8Array,
  poolAddress: Uint8Array,
  tickLower: number,
  tickUpper: number,
  positionMintPubkey: Uint8Array,
): Promise<RuntimeTransaction> {
  const programId = getClammProgramIdBytes(config);
  const [positionPda, positionBump] = derivePositionAddress(
    programId,
    positionMintPubkey,
  );
  const positionTokenAccount = PubkeyUtil.getAssociatedTokenAddress(
    positionMintPubkey,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const instruction = await buildOpenPositionInstruction(programId, {
    funder: userPubkey,
    owner: userPubkey,
    position: positionPda,
    positionMint: positionMintPubkey,
    positionTokenAccount,
    whirlpool: poolAddress,
    positionBump,
    tickLowerIndex: tickLower,
    tickUpperIndex: tickUpper,
  });

  return buildTransaction([instruction], userPubkey);
}

export async function buildAddLiquidityTransaction(
  config: NetworkConfig,
  userPubkey: Uint8Array,
  poolAddress: Uint8Array,
  pool: WhirlpoolState,
  positionMint: Uint8Array,
  tickLower: number,
  tickUpper: number,
  liquidityAmount: bigint,
  tokenMaxA: bigint,
  tokenMaxB: bigint,
): Promise<RuntimeTransaction> {
  const programId = getClammProgramIdBytes(config);
  const [positionAddress] = derivePositionAddress(programId, positionMint);
  const positionTokenAccount = PubkeyUtil.getAssociatedTokenAddress(
    positionMint,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userAtaA = PubkeyUtil.getAssociatedTokenAddress(
    pool.tokenMintA,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userAtaB = PubkeyUtil.getAssociatedTokenAddress(
    pool.tokenMintB,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const tickArrayLower = deriveTickArrayAddress(
    programId,
    poolAddress,
    getStartTickIndex(tickLower, pool.tickSpacing),
  );
  const tickArrayUpper = deriveTickArrayAddress(
    programId,
    poolAddress,
    getStartTickIndex(tickUpper, pool.tickSpacing),
  );

  const instruction = await buildIncreaseLiquidityInstruction(programId, {
    whirlpool: poolAddress,
    tokenAuthority: userPubkey,
    position: positionAddress,
    positionTokenAccount,
    tokenOwnerAccountA: userAtaA,
    tokenOwnerAccountB: userAtaB,
    tokenVaultA: pool.tokenVaultA,
    tokenVaultB: pool.tokenVaultB,
    tickArrayLower,
    tickArrayUpper,
    liquidityAmount,
    tokenMaxA,
    tokenMaxB,
  });

  return buildTransaction([instruction], userPubkey);
}

export async function buildRemoveLiquidityTransaction(
  config: NetworkConfig,
  userPubkey: Uint8Array,
  poolAddress: Uint8Array,
  pool: WhirlpoolState,
  positionMint: Uint8Array,
  tickLower: number,
  tickUpper: number,
  liquidityAmount: bigint,
  tokenMinA: bigint,
  tokenMinB: bigint,
): Promise<RuntimeTransaction> {
  const programId = getClammProgramIdBytes(config);
  const [positionAddress] = derivePositionAddress(programId, positionMint);
  const positionTokenAccount = PubkeyUtil.getAssociatedTokenAddress(
    positionMint,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userAtaA = PubkeyUtil.getAssociatedTokenAddress(
    pool.tokenMintA,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userAtaB = PubkeyUtil.getAssociatedTokenAddress(
    pool.tokenMintB,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const tickArrayLower = deriveTickArrayAddress(
    programId,
    poolAddress,
    getStartTickIndex(tickLower, pool.tickSpacing),
  );
  const tickArrayUpper = deriveTickArrayAddress(
    programId,
    poolAddress,
    getStartTickIndex(tickUpper, pool.tickSpacing),
  );

  const instruction = await buildDecreaseLiquidityInstruction(programId, {
    whirlpool: poolAddress,
    tokenAuthority: userPubkey,
    position: positionAddress,
    positionTokenAccount,
    tokenOwnerAccountA: userAtaA,
    tokenOwnerAccountB: userAtaB,
    tokenVaultA: pool.tokenVaultA,
    tokenVaultB: pool.tokenVaultB,
    tickArrayLower,
    tickArrayUpper,
    liquidityAmount,
    tokenMinA,
    tokenMinB,
  });

  return buildTransaction([instruction], userPubkey);
}

export async function buildCollectFeesTransaction(
  config: NetworkConfig,
  userPubkey: Uint8Array,
  poolAddress: Uint8Array,
  pool: WhirlpoolState,
  positionMint: Uint8Array,
): Promise<RuntimeTransaction> {
  const programId = getClammProgramIdBytes(config);
  const [positionAddress] = derivePositionAddress(programId, positionMint);
  const positionTokenAccount = PubkeyUtil.getAssociatedTokenAddress(
    positionMint,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userAtaA = PubkeyUtil.getAssociatedTokenAddress(
    pool.tokenMintA,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userAtaB = PubkeyUtil.getAssociatedTokenAddress(
    pool.tokenMintB,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const instruction = await buildCollectFeesInstruction(programId, {
    whirlpool: poolAddress,
    positionAuthority: userPubkey,
    position: positionAddress,
    positionTokenAccount,
    tokenOwnerAccountA: userAtaA,
    tokenVaultA: pool.tokenVaultA,
    tokenOwnerAccountB: userAtaB,
    tokenVaultB: pool.tokenVaultB,
  });

  return buildTransaction([instruction], userPubkey);
}

export async function buildClosePositionTransaction(
  config: NetworkConfig,
  userPubkey: Uint8Array,
  positionMint: Uint8Array,
): Promise<RuntimeTransaction> {
  const programId = getClammProgramIdBytes(config);
  const [positionAddress] = derivePositionAddress(programId, positionMint);
  const positionTokenAccount = PubkeyUtil.getAssociatedTokenAddress(
    positionMint,
    userPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const instruction = await buildClosePositionInstruction(programId, {
    positionAuthority: userPubkey,
    receiver: userPubkey,
    position: positionAddress,
    positionMint,
    positionTokenAccount,
  });

  return buildTransaction([instruction], userPubkey);
}
