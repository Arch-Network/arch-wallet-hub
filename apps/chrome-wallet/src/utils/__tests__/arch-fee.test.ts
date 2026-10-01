import { describe, it, expect } from "vitest";
import bs58 from "bs58";
import { SanitizedMessageUtil, type Instruction, type Pubkey } from "@arch-network/arch-sdk";
import {
  ARCH_BASE_FEE_PER_SIGNATURE,
  archMessageFee,
  feeChargedTo,
  isRentDust,
  minimumRent,
  MIN_WALLET_BALANCE_LAMPORTS,
} from "../arch-fee";
import { hubIntentFee } from "../hub-signing-request-verify";

const key = (b: number): Pubkey => new Uint8Array(32).fill(b);
const PAYER = key(1);
const CO_SIGNER = key(2);
const PROGRAM = key(9);

function compile(signers: Pubkey[]) {
  const ix: Instruction = {
    program_id: PROGRAM,
    accounts: [
      ...signers.map((pubkey) => ({ pubkey, is_signer: true, is_writable: true })),
      { pubkey: key(3), is_signer: false, is_writable: true },
    ],
    data: new Uint8Array([0]),
  };
  const msg = SanitizedMessageUtil.createSanitizedMessage([ix], PAYER, new Uint8Array(32));
  if (typeof msg === "string") throw new Error(msg);
  return msg;
}

describe("archMessageFee", () => {
  it("is BASE_FEE_PER_SIGNATURE (5,000) for one signer", () => {
    expect(ARCH_BASE_FEE_PER_SIGNATURE).toBe(5_000n);
    const msg = compile([PAYER]);
    expect(msg.header.num_required_signatures).toBe(1);
    expect(archMessageFee(msg)).toEqual({ feeLamports: 5_000n, feePayer: bs58.encode(PAYER) });
  });

  it("scales with num_required_signatures (two signers = 10,000)", () => {
    const msg = compile([PAYER, CO_SIGNER]);
    expect(msg.header.num_required_signatures).toBe(2);
    expect(archMessageFee(msg)).toEqual({ feeLamports: 10_000n, feePayer: bs58.encode(PAYER) });
  });
});

describe("feeChargedTo", () => {
  const fee = { feeLamports: 5_000n, feePayer: bs58.encode(PAYER) };
  it("charges the fee payer, not other accounts", () => {
    expect(feeChargedTo(fee, bs58.encode(PAYER))).toBe(5_000n);
    expect(feeChargedTo(fee, bs58.encode(CO_SIGNER))).toBe(0n);
  });
  it("is unknown without a fee or an account", () => {
    expect(feeChargedTo(null, bs58.encode(PAYER))).toBeNull();
    expect(feeChargedTo(fee, undefined)).toBeNull();
  });
});

describe("hubIntentFee", () => {
  const user = bs58.encode(key(4));
  const to = bs58.encode(key(5));
  it("charges the user one signature for Hub-built ARCH and token transfers", () => {
    for (const intent of [
      { type: "arch.transfer" as const, toAddress: to, lamports: "1" },
      { type: "arch.token_transfer" as const, mintAddress: bs58.encode(key(6)), toAddress: to, amount: "1" },
    ]) {
      expect(hubIntentFee(intent, user)).toEqual({ feeLamports: 5_000n, feePayer: user });
    }
  });
  it("is null (unknown) when the intent can't be compiled", () => {
    expect(hubIntentFee({ type: "arch.transfer", toAddress: "not-base58!", lamports: "1" }, user)).toBeNull();
    expect(hubIntentFee({ type: "arch.transfer", toAddress: to, lamports: "1" }, undefined)).toBeNull();
  });
});

describe("rent (program/src/rent.rs minimum_rent)", () => {
  it("is (128 + data_len) * 2", () => {
    expect(minimumRent(0)).toBe(256n);
    expect(minimumRent(165)).toBe(586n);
    expect(MIN_WALLET_BALANCE_LAMPORTS).toBe(256n);
  });
  it("treats only 1..255 as dust for a data-less account", () => {
    expect([0n, 1n, 255n, 256n].map(isRentDust)).toEqual([false, true, true, false]);
  });
});
