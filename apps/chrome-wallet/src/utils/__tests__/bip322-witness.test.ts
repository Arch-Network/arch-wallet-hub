import { describe, expect, it } from "vitest";
import { Witness } from "@saturnbtcio/bip322-js";
import {
  decodeRawWalletSignature,
  extractSchnorrHexFromWalletSignature,
  getWalletWitnessSignatureItem,
} from "../bip322-witness";

function hex(n: number, byte = 0xab): string {
  return byte.toString(16).padStart(2, "0").repeat(n);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("bip322-witness extract", () => {
  it("unwraps a BIP-322 simple witness blob to 64-byte hex", () => {
    const schnorr = Uint8Array.from({ length: 64 }, (_, i) => i);
    const blob = Witness.serialize([schnorr]);
    const item = getWalletWitnessSignatureItem(blob);
    expect(item).not.toBeNull();
    expect(item!.length).toBe(64);
    expect(extractSchnorrHexFromWalletSignature(blob)).toBe(bytesToHex(schnorr));
  });

  it("accepts raw 64-byte hex without witness framing", () => {
    const raw = hex(64, 0xcd);
    expect(extractSchnorrHexFromWalletSignature(raw)).toBe(raw);
  });

  it("prefers hex decoding when input is hex-like", () => {
    const raw = hex(64, 0x11);
    const bytes = decodeRawWalletSignature(raw);
    expect(bytes.length).toBe(64);
    expect(bytes[0]).toBe(0x11);
  });

  it("strips a trailing sighash byte from a 65-byte witness item", () => {
    const schnorr = Uint8Array.from({ length: 64 }, (_, i) => (i + 1) & 0xff);
    const withSighash = new Uint8Array(65);
    withSighash.set(schnorr);
    withSighash[64] = 0x01;
    const blob = Witness.serialize([withSighash]);
    expect(extractSchnorrHexFromWalletSignature(blob)).toBe(bytesToHex(schnorr));
  });
});
