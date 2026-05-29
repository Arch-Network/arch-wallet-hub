/**
 * Tests for the coin-selection portion of btc-psbt.ts.
 *
 * Two critical invariants:
 *   1. SAFETY: an inscribed or runed UTXO must NEVER end up in the
 *      selected set when other spendable UTXOs are available.
 *   2. BACKWARDS COMPAT: when no UTXO carries protection metadata
 *      (legacy / pre-Titan indexer), behavior matches the previous
 *      "largest-first, no filtering" algorithm exactly.
 *
 * Error-code differentiation matters too -- callers (Send UI) branch
 * on it to render different copy.
 */
import { describe, it, expect } from "vitest";
import { selectUtxos } from "../btc-psbt";
import type { BtcUtxo } from "../indexer";

const FEE = 1000;

function plain(value: number, txid: string): BtcUtxo {
  return { txid, vout: 0, value };
}

function inscribed(value: number, txid: string): BtcUtxo {
  return { txid, vout: 0, value, inscriptions: [{ id: `${txid}i0` }] };
}

function runed(value: number, txid: string): BtcUtxo {
  return {
    txid,
    vout: 0,
    value,
    runes: [{ rune_id: "73393:191", spaced_name: "X", amount: "1" }]
  };
}

describe("selectUtxos — backwards compatibility (no protection metadata)", () => {
  it("picks largest-first when all UTXOs are plain", () => {
    const utxos = [plain(10_000, "a"), plain(50_000, "b"), plain(25_000, "c")];
    const r = selectUtxos(utxos, 40_000, FEE);
    expect(r.selected.map((u) => u.txid)).toEqual(["b"]);
    expect(r.totalInput).toBe(50_000);
  });

  it("accumulates multiple inputs when one isn't enough", () => {
    const utxos = [plain(10_000, "a"), plain(15_000, "b"), plain(25_000, "c")];
    const r = selectUtxos(utxos, 40_000, FEE);
    expect(r.selected.map((u) => u.txid)).toEqual(["c", "b", "a"]);
    expect(r.totalInput).toBe(50_000);
  });

  it("throws INSUFFICIENT_BALANCE when totals fall short", () => {
    const utxos = [plain(1_000, "a"), plain(2_000, "b")];
    try {
      selectUtxos(utxos, 10_000, FEE);
      throw new Error("expected throw");
    } catch (err: any) {
      expect(err.code).toBe("INSUFFICIENT_BALANCE");
    }
  });
});

describe("selectUtxos — protection-aware behavior", () => {
  it("excludes inscribed UTXOs even when they're the largest by far", () => {
    // A 500_000 sat inscribed UTXO (Ordinal worth real money) is
    // present alongside a smaller plain UTXO. The naive picker
    // would consume the inscribed one. Protection-aware picker
    // MUST choose the plain one.
    const utxos = [
      inscribed(500_000, "ordinal"),
      plain(20_000, "plain")
    ];
    const r = selectUtxos(utxos, 15_000, FEE);
    expect(r.selected.map((u) => u.txid)).toEqual(["plain"]);
    expect(r.selected.find((u) => u.txid === "ordinal")).toBeUndefined();
  });

  it("excludes runed UTXOs from selection", () => {
    const utxos = [
      runed(500_000, "rune"),
      plain(20_000, "plain")
    ];
    const r = selectUtxos(utxos, 15_000, FEE);
    expect(r.selected.map((u) => u.txid)).toEqual(["plain"]);
  });

  it("throws INSUFFICIENT_SPENDABLE_BTC when only protected UTXOs would cover the send", () => {
    // Spendable balance: 5_000 sats (one plain UTXO).
    // Protected balance: 100_000 sats (one inscription).
    // Send target: 10_000 sats + 1000 fee.
    // Total >= needed BUT spendable alone is not -- this is the
    // case where we want to surface "your BTC is locked in
    // inscriptions" instead of generic "insufficient balance".
    const utxos = [plain(5_000, "plain"), inscribed(100_000, "ordinal")];
    try {
      selectUtxos(utxos, 10_000, FEE);
      throw new Error("expected throw");
    } catch (err: any) {
      expect(err.code).toBe("INSUFFICIENT_SPENDABLE_BTC");
      expect(err.spendableSats).toBe(5_000);
      expect(err.protectedSats).toBe(100_000);
      expect(err.message).toMatch(/spendable/i);
      expect(err.message).toMatch(/inscriptions/i);
    }
  });

  it("throws INSUFFICIENT_BALANCE (not SPENDABLE) when even total can't cover", () => {
    // Both spendable and total fall short. Plain "not enough BTC".
    const utxos = [plain(1_000, "plain"), inscribed(2_000, "ordinal")];
    try {
      selectUtxos(utxos, 50_000, FEE);
      throw new Error("expected throw");
    } catch (err: any) {
      expect(err.code).toBe("INSUFFICIENT_BALANCE");
    }
  });

  it("throws INSUFFICIENT_SPENDABLE_BTC when address has ONLY protected UTXOs", () => {
    const utxos = [inscribed(100_000, "ord1"), runed(50_000, "rune1")];
    try {
      selectUtxos(utxos, 10_000, FEE);
      throw new Error("expected throw");
    } catch (err: any) {
      expect(err.code).toBe("INSUFFICIENT_SPENDABLE_BTC");
      expect(err.spendableSats).toBe(0);
      expect(err.protectedSats).toBe(150_000);
    }
  });

  it("never consumes a protected UTXO even when spendable just barely covers", () => {
    // Tight: spendable just covers (15_000 + 1000 fee = 16_000;
    // single 16_000 plain UTXO exists). The inscribed UTXO is
    // 5x larger -- a buggy picker that sorts before filtering
    // would still grab it.
    const utxos = [plain(16_000, "plain-tight"), inscribed(80_000, "ordinal")];
    const r = selectUtxos(utxos, 15_000, FEE);
    expect(r.selected.map((u) => u.txid)).toEqual(["plain-tight"]);
  });
});
