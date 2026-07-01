/**
 * AMM instruction-builder wire-layout tests (post security-hardening ABI).
 *
 * These lock the Borsh byte layout to the on-chain `SwapArgs` / `AddLiquidityArgs`
 * and verify the Hub's defense-in-depth clamps:
 *   - swap no longer carries caller-supplied reserve inputs or input amounts,
 *   - the fee rate is clamped to the protocol ceiling,
 *   - add_liquidity confirmations are floored to the protocol minimum.
 */
import { describe, it, expect } from "vitest";
import type { Pubkey } from "@arch-network/arch-sdk";
import {
  buildAmmSwapInstruction,
  buildAmmAddLiquidityInstruction,
  MAX_FEE_RATE_SAT_VB,
  MIN_DEPOSIT_CONFIRMATIONS,
} from "../ammInstructions.js";

const pk = (n: number): Pubkey => new Uint8Array(32).fill(n) as unknown as Pubkey;

function u32le(data: Uint8Array, off: number): number {
  return data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24);
}
function u64le(data: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(data[off + i]) << (8n * BigInt(i));
  return v;
}

describe("buildAmmSwapInstruction", () => {
  const recipientScript = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(7)]);

  it("encodes the outpoint-only user input with no reserve inputs, fixed length", () => {
    const ix = buildAmmSwapInstruction({
      programId: pk(1),
      pool: pk(2),
      user: pk(3),
      baseToQuote: false,
      amountIn: 2000n,
      minOut: 1n,
      nonce: 0n,
      userInput: { txid: new Uint8Array(32).fill(9), vout: 0 },
      recipientScript,
      feeRateSatVb: 5n,
    });
    // disc(8) + bool(1) + amountIn(16) + minOut(16) + nonce(8)
    //   + userInput{txid(32)+vout(4)} + recipientScript{len(4)+34} + fee(8)
    const expected = 8 + 1 + 16 + 16 + 8 + 36 + (4 + recipientScript.length) + 8;
    expect(ix.data.length).toBe(expected);
    // Two accounts only: pool (writable) + user (signer).
    expect(ix.accounts).toHaveLength(2);
    expect(ix.accounts[1].is_signer).toBe(true);
  });

  it("clamps an abusive fee rate down to the protocol ceiling", () => {
    const ix = buildAmmSwapInstruction({
      programId: pk(1),
      pool: pk(2),
      user: pk(3),
      baseToQuote: true,
      amountIn: 10n,
      minOut: 1n,
      nonce: 7n,
      userInput: { txid: new Uint8Array(32).fill(9), vout: 1 },
      recipientScript,
      feeRateSatVb: 5_000_000n,
    });
    const feeOffset = ix.data.length - 8;
    expect(u64le(ix.data, feeOffset)).toBe(MAX_FEE_RATE_SAT_VB);
  });
});

describe("buildAmmAddLiquidityInstruction", () => {
  it("floors caller confirmations (including 0) to the protocol minimum", () => {
    const ix = buildAmmAddLiquidityInstruction({
      programId: pk(1),
      pool: pk(2),
      position: pk(3),
      lp: pk(4),
      systemProgram: pk(0),
      baseTxid: new Uint8Array(32).fill(1),
      baseVout: 0,
      quoteTxid: new Uint8Array(32).fill(2),
      quoteVout: 1,
      minConfirmations: 0,
    });
    // disc(8)+baseTxid(32)+baseVout(4)+quoteTxid(32)+quoteVout(4)+minConf(4)
    const minConfOffset = 8 + 32 + 4 + 32 + 4;
    expect(u32le(ix.data, minConfOffset)).toBe(MIN_DEPOSIT_CONFIRMATIONS);
  });

  it("preserves a caller value above the minimum", () => {
    const ix = buildAmmAddLiquidityInstruction({
      programId: pk(1),
      pool: pk(2),
      position: pk(3),
      lp: pk(4),
      systemProgram: pk(0),
      baseTxid: new Uint8Array(32).fill(1),
      baseVout: 0,
      quoteTxid: new Uint8Array(32).fill(2),
      quoteVout: 1,
      minConfirmations: 20,
    });
    const minConfOffset = 8 + 32 + 4 + 32 + 4;
    expect(u32le(ix.data, minConfOffset)).toBe(20);
  });
});
