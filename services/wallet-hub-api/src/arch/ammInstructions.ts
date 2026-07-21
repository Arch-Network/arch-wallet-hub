/**
 * Instruction builders for the native-settlement AMM (`arch-bitcoin-defi`).
 *
 * Mirrors the on-chain Anchor/Borsh arg layouts so the Hub can construct
 * `swap.rune_native` and `pool.add_liquidity` Arch transactions that the user
 * authorizes with the same BIP-322 path as `arch.transfer`/`arch.anchor`. The
 * Bitcoin settlement itself is co-signed by the validator FROST set when the
 * program runs — the Hub does not custody anything here.
 *
 * Kept self-contained (no cross-repo dependency on the SDK package) and aligned
 * with the existing `buildTokenTransferInstruction` style in
 * `routes/signingRequests.ts`.
 */

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { PubkeyUtil, type AccountMeta, type Instruction, type Pubkey } from "@arch-network/arch-sdk";
import { parsePubkey } from "./arch.js";

/** Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
function discriminator(name: string): Uint8Array {
  const digest = createHash("sha256").update(`global:${name}`, "utf8").digest();
  return new Uint8Array(digest.subarray(0, 8));
}

class BorshWriter {
  private bytes: number[] = [];

  private uLE(v: bigint, n: number): this {
    let x = v;
    for (let i = 0; i < n; i++) {
      this.bytes.push(Number(x & 0xffn));
      x >>= 8n;
    }
    return this;
  }

  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  u16(v: number): this {
    return this.uLE(BigInt(v), 2);
  }
  u32(v: number): this {
    return this.uLE(BigInt(v), 4);
  }
  u64(v: bigint): this {
    return this.uLE(v, 8);
  }
  u128(v: bigint): this {
    return this.uLE(v, 16);
  }
  raw(b: Uint8Array): this {
    for (const x of b) this.bytes.push(x);
    return this;
  }
  vecBytes(b: Uint8Array): this {
    this.u32(b.length);
    return this.raw(b);
  }
  vecLen(n: number): this {
    return this.u32(n);
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export interface RuneId {
  block: bigint;
  tx: number;
}

/**
 * The user's own input outpoint for a swap. Mirrors on-chain `swap::UserInput`.
 * Amounts are intentionally absent: the program verifies the input's sat/rune
 * value on-chain, so the Hub never declares (and cannot lie about) them.
 */
export interface UserInput {
  /** 32-byte txid (internal byte order). */
  txid: Uint8Array;
  vout: number;
}

/**
 * Protocol ceiling on the settlement fee rate (sat/vB). Mirrors the on-chain
 * `MAX_FEE_RATE_SAT_VB`; enforced here as defense-in-depth (authority is on
 * chain). Requests above this are clamped down rather than rejected.
 */
export const MAX_FEE_RATE_SAT_VB = 1_000n;

/** Minimum deposit confirmations. Mirrors on-chain `DEFAULT_MIN_CONFIRMATIONS`. */
export const MIN_DEPOSIT_CONFIRMATIONS = 6;

function clampFeeRate(v: bigint): bigint {
  if (v < 0n) return 0n;
  return v > MAX_FEE_RATE_SAT_VB ? MAX_FEE_RATE_SAT_VB : v;
}

function writeRuneId(w: BorshWriter, id: RuneId): void {
  w.u64(id.block).u32(id.tx);
}

function writeUserInput(w: BorshWriter, u: UserInput): void {
  if (u.txid.length !== 32) throw new Error("UserInput.txid must be 32 bytes");
  w.raw(u.txid).u32(u.vout);
}

function meta(pubkey: Pubkey, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey, is_signer: isSigner, is_writable: isWritable } as AccountMeta;
}

export interface SwapInstructionParams {
  programId: Pubkey;
  pool: Pubkey;
  user: Pubkey;
  baseToQuote: boolean;
  amountIn: bigint;
  minOut: bigint;
  nonce: bigint;
  userInput: UserInput;
  recipientScript: Uint8Array;
  feeRateSatVb: bigint;
}

export function buildAmmSwapInstruction(p: SwapInstructionParams): Instruction {
  const w = new BorshWriter().raw(discriminator("swap"));
  w.bool(p.baseToQuote).u128(p.amountIn).u128(p.minOut).u64(p.nonce);
  writeUserInput(w, p.userInput);
  w.vecBytes(p.recipientScript);
  w.u64(clampFeeRate(p.feeRateSatVb));
  return {
    program_id: p.programId,
    accounts: [meta(p.pool, false, true), meta(p.user, true, false)],
    data: w.finish(),
  };
}

export interface AddLiquidityInstructionParams {
  programId: Pubkey;
  pool: Pubkey;
  position: Pubkey;
  lp: Pubkey;
  systemProgram: Pubkey;
  baseTxid: Uint8Array;
  baseVout: number;
  quoteTxid: Uint8Array;
  quoteVout: number;
  minConfirmations: number;
}

export function buildAmmAddLiquidityInstruction(p: AddLiquidityInstructionParams): Instruction {
  if (p.baseTxid.length !== 32 || p.quoteTxid.length !== 32) {
    throw new Error("txids must be 32 bytes");
  }
  // Floor confirmations to the protocol minimum (the program enforces this too).
  const minConfirmations = Math.max(p.minConfirmations, MIN_DEPOSIT_CONFIRMATIONS);
  const w = new BorshWriter().raw(discriminator("add_liquidity"));
  w.raw(p.baseTxid).u32(p.baseVout).raw(p.quoteTxid).u32(p.quoteVout).u32(minConfirmations);
  return {
    program_id: p.programId,
    accounts: [
      meta(p.pool, false, true),
      meta(p.position, false, true),
      meta(p.lp, true, true),
      meta(p.systemProgram, false, false),
    ],
    data: w.finish(),
  };
}

// ── Signing-request action helpers ─────────────────────────────────────────
// These bridge the route's action payloads (JSON strings/hex) to instructions
// and a serializable `display` that the submit handler can rebuild from.

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/** An outpoint as it appears in an action payload / display (JSON-safe). */
export interface OutpointJson {
  txid: string; // 32-byte txid hex, internal byte order
  vout: number;
}

function outpointFromJson(u: OutpointJson): UserInput {
  return { txid: hexToBytes(u.txid), vout: u.vout };
}

export interface SwapAction {
  type: "swap.rune_native";
  programId: string;
  poolAddress: string;
  runeId: { block: string; tx: number };
  baseToQuote: boolean;
  amountIn: string;
  minOut: string;
  nonce: string;
  /** User's input outpoint only; the program verifies amounts on-chain. */
  userInput: OutpointJson;
  recipientScriptHex: string;
  feeRateSatVb: string;
}

export interface AddLiquidityAction {
  type: "pool.add_liquidity";
  programId: string;
  poolAddress: string;
  positionAddress: string;
  baseTxid: string;
  baseVout: number;
  quoteTxid: string;
  quoteVout: number;
  minConfirmations: number;
}

/** Build the swap instruction + a rebuildable display from an action payload. */
export function buildSwapAction(action: SwapAction, userPubkey: Pubkey): {
  instructions: Instruction[];
  display: Record<string, unknown>;
} {
  const ix = buildAmmSwapInstruction({
    programId: parsePubkey(action.programId),
    pool: parsePubkey(action.poolAddress),
    user: userPubkey,
    baseToQuote: action.baseToQuote,
    amountIn: BigInt(action.amountIn),
    minOut: BigInt(action.minOut),
    nonce: BigInt(action.nonce),
    userInput: outpointFromJson(action.userInput),
    recipientScript: hexToBytes(action.recipientScriptHex),
    feeRateSatVb: BigInt(action.feeRateSatVb),
  });
  const { type: _t, ...rest } = action;
  return { instructions: [ix], display: { kind: "swap.rune_native", ...rest } };
}

export function rebuildSwapInstructions(display: Record<string, any>, userPubkey: Pubkey): Instruction[] {
  return buildSwapAction({ type: "swap.rune_native", ...(display as any) }, userPubkey).instructions;
}

/** Build the add-liquidity instruction + display from an action payload. */
export function buildAddLiquidityAction(action: AddLiquidityAction, lpPubkey: Pubkey): {
  instructions: Instruction[];
  display: Record<string, unknown>;
} {
  const ix = buildAmmAddLiquidityInstruction({
    programId: parsePubkey(action.programId),
    pool: parsePubkey(action.poolAddress),
    position: parsePubkey(action.positionAddress),
    lp: lpPubkey,
    systemProgram: PubkeyUtil.systemProgram(),
    baseTxid: hexToBytes(action.baseTxid),
    baseVout: action.baseVout,
    quoteTxid: hexToBytes(action.quoteTxid),
    quoteVout: action.quoteVout,
    minConfirmations: action.minConfirmations,
  });
  const { type: _t, ...rest } = action;
  return { instructions: [ix], display: { kind: "pool.add_liquidity", ...rest } };
}

export function rebuildAddLiquidityInstructions(
  display: Record<string, any>,
  lpPubkey: Pubkey,
): Instruction[] {
  return buildAddLiquidityAction({ type: "pool.add_liquidity", ...(display as any) }, lpPubkey).instructions;
}
