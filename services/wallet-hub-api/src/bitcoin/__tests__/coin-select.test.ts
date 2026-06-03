import { describe, it, expect } from "vitest";
import { selectUtxos } from "../../routes/btcTransactions.js";
import { dustThresholdForAddress } from "../dust.js";
import { isProtectedUtxo, type BtcUtxo } from "../protection.js";

let txidSeq = 0;
function utxo(value: number, extra: Partial<BtcUtxo> = {}): BtcUtxo {
  txidSeq += 1;
  return {
    txid: `tx${txidSeq}`,
    vout: 0,
    value,
    status: { confirmed: true },
    ...extra,
  };
}

const inscribed = (value: number) => utxo(value, { inscriptions: [{ id: "insc-1" }] });
const runed = (value: number) => utxo(value, { runes: [{ rune_id: "840000:1", amount: "50" }] });
const riskyRuned = (value: number) =>
  utxo(value, { risky_runes: [{ rune_id: "840000:2", amount: "10" }] });

describe("selectUtxos protection", () => {
  it("never selects an inscribed UTXO even when it's the largest", () => {
    const utxos = [utxo(10_000), inscribed(50_000)];
    const { selected } = selectUtxos(utxos, 5_000, 1_000);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.value).toBe(10_000);
    expect(selected.some(isProtectedUtxo)).toBe(false);
  });

  it("never selects a runed UTXO as fee fodder", () => {
    const utxos = [utxo(8_000), runed(100_000)];
    const { selected, totalInput } = selectUtxos(utxos, 3_000, 1_000);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.value).toBe(8_000);
    expect(totalInput).toBe(8_000);
  });

  it("never selects a risky-runed (mempool-pending) UTXO", () => {
    const utxos = [utxo(9_000), riskyRuned(80_000)];
    const { selected } = selectUtxos(utxos, 4_000, 1_000);
    expect(selected.some(isProtectedUtxo)).toBe(false);
  });

  it("treats zero-amount rune entries as spendable", () => {
    // A 0-balance rune entry must not lock an otherwise-plain UTXO.
    const u = utxo(20_000, { runes: [{ rune_id: "x", amount: "0" }] });
    const { selected } = selectUtxos([u], 5_000, 1_000);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.value).toBe(20_000);
  });
});

describe("selectUtxos insufficiency modes", () => {
  it("throws INSUFFICIENT_SPENDABLE_BTC when protected funds would have covered it", () => {
    const utxos = [utxo(1_000), inscribed(100_000)];
    try {
      selectUtxos(utxos, 50_000, 1_000);
      throw new Error("expected selectUtxos to throw");
    } catch (err: any) {
      expect(err.code).toBe("INSUFFICIENT_SPENDABLE_BTC");
      expect(err.spendableSats).toBe(1_000);
      expect(err.protectedSats).toBe(100_000);
    }
  });

  it("throws INSUFFICIENT_BALANCE when even protected funds fall short", () => {
    const utxos = [utxo(1_000), inscribed(2_000)];
    try {
      selectUtxos(utxos, 50_000, 1_000);
      throw new Error("expected selectUtxos to throw");
    } catch (err: any) {
      expect(err.code).toBe("INSUFFICIENT_BALANCE");
    }
  });
});

describe("selectUtxos unenriched parity", () => {
  it("selects largest-first exactly like the naive path when no protection fields exist", () => {
    const utxos = [utxo(5_000), utxo(20_000), utxo(8_000)];
    const { selected, totalInput } = selectUtxos(utxos, 10_000, 1_000);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.value).toBe(20_000);
    expect(totalInput).toBe(20_000);
  });

  it("accumulates multiple inputs until target+fee is covered", () => {
    const utxos = [utxo(5_000), utxo(8_000)];
    const { selected, totalInput } = selectUtxos(utxos, 10_000, 1_000);
    expect(selected).toHaveLength(2);
    expect(totalInput).toBe(13_000);
  });
});

describe("dustThresholdForAddress", () => {
  it("returns 330 for taproot (bc1p / tb1p)", () => {
    expect(dustThresholdForAddress("bc1p5cyxnuxmeuwuvkwfem96lqzszd0w68z")).toBe(330);
    expect(dustThresholdForAddress("tb1p5cyxnuxmeuwuvkwfem96lqzszd0w68z")).toBe(330);
  });

  it("returns 294 for native segwit p2wpkh", () => {
    expect(dustThresholdForAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe(294);
  });

  it("falls back to 546 for unclassifiable addresses", () => {
    expect(dustThresholdForAddress("not-an-address")).toBe(546);
    expect(dustThresholdForAddress("")).toBe(546);
  });
});
