import {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  RENT_SYSVAR_ID,
} from "@/lib/clamm/constants";
import {
  encodeU16LE,
  encodeU64LE,
  encodeU128LE,
  encodeI32LE,
} from "@/lib/arch/borsh";
import type { SdkInstruction } from "@/lib/arch/tx-builder";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@/lib/arch/program-ids";

// ── Anchor discriminator computation ───────────────────────────────────────
// Anchor uses sha256("global:<instruction_name>")[0..8]

async function computeDiscriminator(instructionName: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`global:${instructionName}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer).slice(0, 8);
}

const discriminatorCache = new Map<string, Uint8Array>();

async function getDiscriminator(instructionName: string): Promise<Uint8Array> {
  const cached = discriminatorCache.get(instructionName);
  if (cached) return cached;
  const disc = await computeDiscriminator(instructionName);
  discriminatorCache.set(instructionName, disc);
  return disc;
}

// ── Account metadata helper ────────────────────────────────────────────────

function acct(pubkey: Uint8Array, is_signer: boolean, is_writable: boolean) {
  return { pubkey, is_signer, is_writable };
}

function ix(
  programId: Uint8Array,
  accounts: SdkInstruction["accounts"],
  data: Uint8Array,
): SdkInstruction {
  return { program_id: programId, accounts, data };
}

// ── Pool setup instructions ────────────────────────────────────────────────

export async function buildInitializeConfigInstruction(
  programId: Uint8Array,
  params: {
  config: Uint8Array;
  funder: Uint8Array;
  feeAuthority: Uint8Array;
  collectProtocolFeesAuthority: Uint8Array;
  rewardEmissionsSuperAuthority: Uint8Array;
  defaultProtocolFeeRate: number;
}): Promise<SdkInstruction> {
  const disc = await getDiscriminator("initialize_config");
  const data = new Uint8Array([
    ...disc,
    ...params.feeAuthority,
    ...params.collectProtocolFeesAuthority,
    ...params.rewardEmissionsSuperAuthority,
    ...encodeU16LE(params.defaultProtocolFeeRate),
  ]);

  return ix(programId,
    [
      acct(params.config, true, true),      // Bug 4: config must be signer
      acct(params.funder, true, true),
      acct(SYSTEM_PROGRAM_ID, false, false),
    ],
    data,
  );
}

export async function buildInitializeFeeTierInstruction(
  programId: Uint8Array,
  params: {
  config: Uint8Array;
  feeTier: Uint8Array;
  funder: Uint8Array;
  feeAuthority: Uint8Array;
  tickSpacing: number;
  defaultFeeRate: number;
}): Promise<SdkInstruction> {
  const disc = await getDiscriminator("initialize_fee_tier");
  const data = new Uint8Array([
    ...disc,
    ...encodeU16LE(params.tickSpacing),
    ...encodeU16LE(params.defaultFeeRate),
  ]);

  return ix(programId,
    [
      acct(params.config, false, false),
      acct(params.feeTier, false, true),
      acct(params.funder, true, true),
      acct(params.feeAuthority, true, false),
      acct(SYSTEM_PROGRAM_ID, false, false),
    ],
    data,
  );
}

export async function buildInitializePoolInstruction(
  programId: Uint8Array,
  params: {
  whirlpoolsConfig: Uint8Array;
  tokenMintA: Uint8Array;
  tokenMintB: Uint8Array;
  funder: Uint8Array;
  whirlpool: Uint8Array;
  whirlpoolBump: number;           // Bug 2: bump param added
  tokenVaultA: Uint8Array;
  tokenVaultB: Uint8Array;
  feeTier: Uint8Array;
  tickSpacing: number;
  initialSqrtPrice: bigint;
}): Promise<SdkInstruction> {
  const disc = await getDiscriminator("initialize_pool");
  const data = new Uint8Array([
    ...disc,
    params.whirlpoolBump,                   // Bug 2: bump before tickSpacing
    ...encodeU16LE(params.tickSpacing),
    ...encodeU128LE(params.initialSqrtPrice),
  ]);

  return ix(programId,
    [
      acct(params.whirlpoolsConfig, false, false),
      acct(params.tokenMintA, false, false),
      acct(params.tokenMintB, false, false),
      acct(params.funder, true, true),
      acct(params.whirlpool, false, true),
      acct(params.tokenVaultA, true, true),  // Bug 3: vaults are signers
      acct(params.tokenVaultB, true, true),  // Bug 3: vaults are signers
      acct(params.feeTier, false, false),
      acct(TOKEN_PROGRAM_ID, false, false),
      acct(SYSTEM_PROGRAM_ID, false, false),
      acct(RENT_SYSVAR_ID, false, false),
    ],
    data,
  );
}

export async function buildInitializeTickArrayInstruction(
  programId: Uint8Array,
  params: {
  whirlpool: Uint8Array;
  funder: Uint8Array;
  tickArray: Uint8Array;
  startTickIndex: number;
}): Promise<SdkInstruction> {
  const disc = await getDiscriminator("initialize_tick_array");
  const data = new Uint8Array([
    ...disc,
    ...encodeI32LE(params.startTickIndex),
  ]);

  return ix(programId,
    [
      acct(params.whirlpool, false, false),
      acct(params.funder, true, true),
      acct(params.tickArray, false, true),
      acct(SYSTEM_PROGRAM_ID, false, false),
    ],
    data,
  );
}

// ── Swap instruction ───────────────────────────────────────────────────────

/**
 * Borsh-encode `Option<RemainingAccountsInfo>` for the `swap_v2` ix data tail.
 *
 * Wire format (CLAMM `util::v2::remaining_accounts_utils`):
 *   Option<T>            → 1 byte tag (0 = None, 1 = Some) then body
 *   RemainingAccountsInfo → Vec<RemainingAccountsSlice> (u32 LE length + items)
 *   RemainingAccountsSlice → accounts_type: u8 enum + length: u8
 *
 * `AccountsType::SupplementalTickArrays` is the first active enum variant
 * (commented-out TransferHook* variants are skipped in the actual `enum`
 * definition), so it serializes to `0`.
 */
function encodeSupplementalTickArraysInfo(count: number): Uint8Array {
  if (count === 0) {
    return new Uint8Array([0]); // None
  }
  return new Uint8Array([
    1,                  // Some
    1, 0, 0, 0,         // Vec length = 1 (u32 LE)
    0,                  // AccountsType::SupplementalTickArrays = 0
    count & 0xff,       // slice length (u8)
  ]);
}

/**
 * Build a CLAMM `swap_v2` instruction.
 *
 * Differences from the V1 `swap` builder below:
 * 1. Adds `token_mint_a` / `token_mint_b` to the account list (slots 4–5)
 *    so the program can read transfer-fee config from token-2022 mints.
 * 2. Adds `token_program_a` / `token_program_b` (slots 0–1) — currently both
 *    are the same Token program, but V2 is forward-compatible with
 *    Token-2022.
 * 3. Marks `oracle` writable.
 * 4. Appends a borsh-encoded `Option<RemainingAccountsInfo>` to the
 *    instruction data, declaring how many supplemental tick arrays follow
 *    as remaining accounts.
 * 5. Accepts up to 3 supplemental tick array accounts. The program's
 *    `SparseSwapTickSequenceBuilder` matches them to the expected
 *    start-tick-indexes by PDA / on-chain `start_tick_index`, so caller
 *    order doesn't matter — but the count in the encoded info MUST match
 *    `supplementalTickArrays.length`.
 */
export async function buildSwapV2Instruction(
  programId: Uint8Array,
  params: {
  tokenAuthority: Uint8Array;
  whirlpool: Uint8Array;
  tokenMintA: Uint8Array;
  tokenMintB: Uint8Array;
  tokenOwnerAccountA: Uint8Array;
  tokenVaultA: Uint8Array;
  tokenOwnerAccountB: Uint8Array;
  tokenVaultB: Uint8Array;
  tickArray0: Uint8Array;
  tickArray1: Uint8Array;
  tickArray2: Uint8Array;
  oracle: Uint8Array;
  supplementalTickArrays?: Uint8Array[];
  amount: bigint;
  otherAmountThreshold: bigint;
  /** Pass `0n` for "no explicit limit" — program substitutes min/max for direction. */
  sqrtPriceLimit: bigint;
  amountSpecifiedIsInput: boolean;
  aToB: boolean;
}): Promise<SdkInstruction> {
  const supplemental = params.supplementalTickArrays ?? [];
  if (supplemental.length > 3) {
    throw new Error(
      `swap_v2 supports at most 3 supplemental tick arrays, got ${supplemental.length}`,
    );
  }

  const disc = await getDiscriminator("swap_v2");
  const data = new Uint8Array([
    ...disc,
    ...encodeU64LE(params.amount),
    ...encodeU64LE(params.otherAmountThreshold),
    ...encodeU128LE(params.sqrtPriceLimit),
    params.amountSpecifiedIsInput ? 1 : 0,
    params.aToB ? 1 : 0,
    ...encodeSupplementalTickArraysInfo(supplemental.length),
  ]);

  return ix(programId,
    [
      acct(TOKEN_PROGRAM_ID, false, false),         // token_program_a
      acct(TOKEN_PROGRAM_ID, false, false),         // token_program_b
      acct(params.tokenAuthority, true, false),
      acct(params.whirlpool, false, true),
      acct(params.tokenMintA, false, false),
      acct(params.tokenMintB, false, false),
      acct(params.tokenOwnerAccountA, false, true),
      acct(params.tokenVaultA, false, true),
      acct(params.tokenOwnerAccountB, false, true),
      acct(params.tokenVaultB, false, true),
      acct(params.tickArray0, false, true),
      acct(params.tickArray1, false, true),
      acct(params.tickArray2, false, true),
      acct(params.oracle, false, true),
      ...supplemental.map((ta) => acct(ta, false, true)),
    ],
    data,
  );
}

// ── Position management instructions ───────────────────────────────────────

export async function buildOpenPositionInstruction(
  programId: Uint8Array,
  params: {
  funder: Uint8Array;
  owner: Uint8Array;
  position: Uint8Array;
  positionMint: Uint8Array;
  positionTokenAccount: Uint8Array;
  whirlpool: Uint8Array;
  positionBump: number;             // Bug 5: actual bump instead of hardcoded 0
  tickLowerIndex: number;
  tickUpperIndex: number;
}): Promise<SdkInstruction> {
  const disc = await getDiscriminator("open_position");
  const data = new Uint8Array([
    ...disc,
    params.positionBump,                    // Bug 5: use real bump
    ...encodeI32LE(params.tickLowerIndex),
    ...encodeI32LE(params.tickUpperIndex),
  ]);

  return ix(programId,
    [
      acct(params.funder, true, true),
      acct(params.owner, false, false),
      acct(params.position, false, true),
      acct(params.positionMint, true, true),           // Bug 5: mint is signer
      acct(params.positionTokenAccount, false, true),
      acct(params.whirlpool, false, false),
      acct(TOKEN_PROGRAM_ID, false, false),
      acct(SYSTEM_PROGRAM_ID, false, false),
      acct(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), // Bug 5: ATA program, not RENT
    ],
    data,
  );
}

export async function buildIncreaseLiquidityInstruction(
  programId: Uint8Array,
  params: {
  whirlpool: Uint8Array;
  tokenAuthority: Uint8Array;
  position: Uint8Array;
  positionTokenAccount: Uint8Array;
  tokenOwnerAccountA: Uint8Array;
  tokenOwnerAccountB: Uint8Array;
  tokenVaultA: Uint8Array;
  tokenVaultB: Uint8Array;
  tickArrayLower: Uint8Array;
  tickArrayUpper: Uint8Array;
  liquidityAmount: bigint;
  tokenMaxA: bigint;
  tokenMaxB: bigint;
}): Promise<SdkInstruction> {
  const disc = await getDiscriminator("increase_liquidity");
  const data = new Uint8Array([
    ...disc,
    ...encodeU128LE(params.liquidityAmount),
    ...encodeU64LE(params.tokenMaxA),
    ...encodeU64LE(params.tokenMaxB),
  ]);

  return ix(programId,
    [
      acct(params.whirlpool, false, true),
      acct(TOKEN_PROGRAM_ID, false, false),
      acct(params.tokenAuthority, true, false),
      acct(params.position, false, true),
      acct(params.positionTokenAccount, false, false),
      acct(params.tokenOwnerAccountA, false, true),
      acct(params.tokenOwnerAccountB, false, true),
      acct(params.tokenVaultA, false, true),
      acct(params.tokenVaultB, false, true),
      acct(params.tickArrayLower, false, true),
      acct(params.tickArrayUpper, false, true),
    ],
    data,
  );
}

export async function buildDecreaseLiquidityInstruction(
  programId: Uint8Array,
  params: {
  whirlpool: Uint8Array;
  tokenAuthority: Uint8Array;
  position: Uint8Array;
  positionTokenAccount: Uint8Array;
  tokenOwnerAccountA: Uint8Array;
  tokenOwnerAccountB: Uint8Array;
  tokenVaultA: Uint8Array;
  tokenVaultB: Uint8Array;
  tickArrayLower: Uint8Array;
  tickArrayUpper: Uint8Array;
  liquidityAmount: bigint;
  tokenMinA: bigint;
  tokenMinB: bigint;
}): Promise<SdkInstruction> {
  const disc = await getDiscriminator("decrease_liquidity");
  const data = new Uint8Array([
    ...disc,
    ...encodeU128LE(params.liquidityAmount),
    ...encodeU64LE(params.tokenMinA),
    ...encodeU64LE(params.tokenMinB),
  ]);

  return ix(programId,
    [
      acct(params.whirlpool, false, true),
      acct(TOKEN_PROGRAM_ID, false, false),
      acct(params.tokenAuthority, true, false),
      acct(params.position, false, true),
      acct(params.positionTokenAccount, false, false),
      acct(params.tokenOwnerAccountA, false, true),
      acct(params.tokenOwnerAccountB, false, true),
      acct(params.tokenVaultA, false, true),
      acct(params.tokenVaultB, false, true),
      acct(params.tickArrayLower, false, true),
      acct(params.tickArrayUpper, false, true),
    ],
    data,
  );
}

export async function buildCollectFeesInstruction(
  programId: Uint8Array,
  params: {
  whirlpool: Uint8Array;
  positionAuthority: Uint8Array;
  position: Uint8Array;
  positionTokenAccount: Uint8Array;
  tokenOwnerAccountA: Uint8Array;
  tokenVaultA: Uint8Array;
  tokenOwnerAccountB: Uint8Array;
  tokenVaultB: Uint8Array;
}): Promise<SdkInstruction> {
  const disc = await getDiscriminator("collect_fees");

  return ix(programId,
    [
      acct(params.whirlpool, false, false),
      acct(params.positionAuthority, true, false),
      acct(params.position, false, true),
      acct(params.positionTokenAccount, false, false),
      acct(params.tokenOwnerAccountA, false, true),  // Bug 6: interleaved order
      acct(params.tokenVaultA, false, true),          // ownerA, vaultA, ownerB, vaultB
      acct(params.tokenOwnerAccountB, false, true),
      acct(params.tokenVaultB, false, true),
      acct(TOKEN_PROGRAM_ID, false, false),
    ],
    disc,
  );
}

export async function buildCollectRewardInstruction(
  programId: Uint8Array,
  params: {
  whirlpool: Uint8Array;
  positionAuthority: Uint8Array;
  position: Uint8Array;
  positionTokenAccount: Uint8Array;
  rewardOwnerAccount: Uint8Array;
  rewardVault: Uint8Array;
  rewardIndex: number;
}): Promise<SdkInstruction> {
  const disc = await getDiscriminator("collect_reward");
  const data = new Uint8Array([
    ...disc,
    params.rewardIndex,
  ]);

  return ix(programId,
    [
      acct(params.whirlpool, false, false),
      acct(params.positionAuthority, true, false),
      acct(params.position, false, true),
      acct(params.positionTokenAccount, false, false),
      acct(params.rewardOwnerAccount, false, true),
      acct(params.rewardVault, false, true),
      acct(TOKEN_PROGRAM_ID, false, false),
    ],
    data,
  );
}

export async function buildClosePositionInstruction(
  programId: Uint8Array,
  params: {
  positionAuthority: Uint8Array;
  receiver: Uint8Array;
  position: Uint8Array;
  positionMint: Uint8Array;
  positionTokenAccount: Uint8Array;
}): Promise<SdkInstruction> {
  const disc = await getDiscriminator("close_position");

  return ix(programId,
    [
      acct(params.positionAuthority, true, false),
      acct(params.receiver, false, true),
      acct(params.position, false, true),
      acct(params.positionMint, false, true),
      acct(params.positionTokenAccount, false, true),
      acct(TOKEN_PROGRAM_ID, false, false),
    ],
    disc,
  );
}
