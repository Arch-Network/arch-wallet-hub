import { describe, it, expect } from "vitest";
import { txHasRunestone } from "../btc-tx-classify";

describe("txHasRunestone", () => {
  it("detects a runestone via Esplora-shape vout with scriptpubkey_type", () => {
    const tx = {
      vout: [
        {
          scriptpubkey: "6a5d04140164",
          scriptpubkey_type: "op_return",
          value: 0,
        },
        { scriptpubkey: "5120abc...", scriptpubkey_type: "v1_p2tr", value: 546 },
      ],
    };
    expect(txHasRunestone(tx)).toBe(true);
  });

  it("detects a runestone via Titan-native output with script_pubkey_type", () => {
    const tx = {
      output: [
        {
          script_pubkey: "6a5d04140164",
          script_pubkey_type: "op_return",
          value: 0,
        },
        { script_pubkey: "5120abc...", script_pubkey_type: "v1_p2tr", value: 546 },
      ],
    };
    expect(txHasRunestone(tx)).toBe(true);
  });

  it("detects via raw script bytes even when the type tag is missing", () => {
    // Titan responses occasionally omit `script_pubkey_type` on
    // OP_RETURNs; we should still recognize the runestone.
    const tx = {
      output: [{ script_pubkey: "6a5d04140164", value: 0 }],
    };
    expect(txHasRunestone(tx)).toBe(true);
  });

  it("accepts a 0x-prefixed script", () => {
    const tx = {
      vout: [{ scriptpubkey: "0x6a5d04140164", scriptpubkey_type: "op_return", value: 0 }],
    };
    expect(txHasRunestone(tx)).toBe(true);
  });

  it("is case-insensitive on hex", () => {
    const tx = {
      vout: [{ scriptpubkey: "6A5D04140164", scriptpubkey_type: "OP_RETURN", value: 0 }],
    };
    expect(txHasRunestone(tx)).toBe(true);
  });

  it("returns false for an OP_RETURN that is NOT a runestone", () => {
    // OP_RETURN with arbitrary data (no OP_13 magic byte). E.g.,
    // a counterparty / stamps / ord inscription envelope.
    const tx = {
      vout: [
        { scriptpubkey: "6a04deadbeef", scriptpubkey_type: "op_return", value: 0 },
      ],
    };
    expect(txHasRunestone(tx)).toBe(false);
  });

  it("returns false for a plain BTC transaction", () => {
    const tx = {
      vout: [
        { scriptpubkey: "5120aaaa", scriptpubkey_type: "v1_p2tr", value: 10_000 },
        { scriptpubkey: "00141111", scriptpubkey_type: "v0_p2wpkh", value: 5_000 },
      ],
    };
    expect(txHasRunestone(tx)).toBe(false);
  });

  it("returns false when the tx has neither vout nor output", () => {
    expect(txHasRunestone({ txid: "abc" })).toBe(false);
    expect(txHasRunestone({})).toBe(false);
  });

  it("returns false for non-object inputs", () => {
    expect(txHasRunestone(null)).toBe(false);
    expect(txHasRunestone(undefined)).toBe(false);
    expect(txHasRunestone("not an object")).toBe(false);
    expect(txHasRunestone(42)).toBe(false);
  });

  it("recognizes the runestone when it's not the first output", () => {
    // Per the Runes spec the FIRST runestone in a tx is what
    // counts; but as long as one exists in the tx, we label.
    const tx = {
      vout: [
        { scriptpubkey: "5120aaaa", scriptpubkey_type: "v1_p2tr", value: 546 },
        { scriptpubkey: "5120bbbb", scriptpubkey_type: "v1_p2tr", value: 1000 },
        { scriptpubkey: "6a5d04140164", scriptpubkey_type: "op_return", value: 0 },
      ],
    };
    expect(txHasRunestone(tx)).toBe(true);
  });
});
