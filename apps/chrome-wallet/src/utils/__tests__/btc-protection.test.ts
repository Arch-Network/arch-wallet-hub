/**
 * Behavioral tests for the UTXO protection model.
 *
 * Coverage:
 *   - isProtectedUtxo handles every flavor of protection field
 *     (inscriptions, runes, risky_runes), plus their absences
 *   - partitionByProtection sums sats correctly across mixed input
 *   - Defensive edge cases that the Titan indexer doesn't currently
 *     emit but a stricter wallet must still handle gracefully
 *     (empty arrays, zero-amount runes, malformed amount strings)
 */
import { describe, it, expect } from "vitest";
import {
  isProtectedUtxo,
  partitionByProtection,
  reasonsForUtxo
} from "../btc-protection";
import type { BtcUtxo } from "../indexer";

function plain(value: number, txid = "aaaa", vout = 0): BtcUtxo {
  return { txid, vout, value };
}

function inscribed(value: number, txid = "bbbb", vout = 0): BtcUtxo {
  return {
    txid,
    vout,
    value,
    inscriptions: [{ id: `${txid}i${vout}` }]
  };
}

function runed(value: number, txid = "cccc", vout = 0): BtcUtxo {
  return {
    txid,
    vout,
    value,
    runes: [{ rune_id: "73393:191", spaced_name: "UNCOMMON\u2022GOODS", amount: "1" }]
  };
}

function riskyRuned(value: number, txid = "dddd", vout = 0): BtcUtxo {
  return {
    txid,
    vout,
    value,
    risky_runes: [{ rune_id: "73393:191", spaced_name: "UNCOMMON\u2022GOODS", amount: "1" }]
  };
}

describe("isProtectedUtxo", () => {
  it("returns false for plain BTC UTXOs (no protection fields)", () => {
    expect(isProtectedUtxo(plain(100_000))).toBe(false);
  });

  it("returns true when inscriptions are present", () => {
    expect(isProtectedUtxo(inscribed(546))).toBe(true);
  });

  it("returns true when confirmed runes are present", () => {
    expect(isProtectedUtxo(runed(546))).toBe(true);
  });

  it("returns true when mempool-pending (risky) runes are present", () => {
    expect(isProtectedUtxo(riskyRuned(546))).toBe(true);
  });

  it("returns false when inscriptions field is an empty array", () => {
    expect(isProtectedUtxo({ txid: "x", vout: 0, value: 100, inscriptions: [] })).toBe(false);
  });

  it("returns false when rune balance is explicitly zero", () => {
    expect(
      isProtectedUtxo({
        txid: "x",
        vout: 0,
        value: 100,
        runes: [{ rune_id: "1:1", spaced_name: "ZERO", amount: "0" }]
      })
    ).toBe(false);
  });

  it("returns true when a rune entry has a malformed amount (defensive)", () => {
    // Garbage amount: we err on the side of caution and protect the
    // UTXO. The indexer never ships this shape today, but if it
    // ever does we want fail-safe behavior, not silent inclusion in
    // coin selection.
    expect(
      isProtectedUtxo({
        txid: "x",
        vout: 0,
        value: 100,
        runes: [{ rune_id: "1:1", spaced_name: "BAD", amount: "not-a-number" }]
      })
    ).toBe(true);
  });

  it("handles a UTXO carrying BOTH inscriptions AND runes", () => {
    const u: BtcUtxo = {
      txid: "x",
      vout: 0,
      value: 546,
      inscriptions: [{ id: "x:0i0" }],
      runes: [{ rune_id: "1:1", spaced_name: "BOTH", amount: "1" }]
    };
    expect(isProtectedUtxo(u)).toBe(true);
  });
});

describe("reasonsForUtxo", () => {
  it("returns empty for plain UTXOs", () => {
    expect(reasonsForUtxo(plain(100))).toEqual([]);
  });

  it("returns single inscription reason for inscribed-only UTXOs", () => {
    expect(reasonsForUtxo(inscribed(546))).toEqual([
      { kind: "inscription", count: 1 }
    ]);
  });

  it("returns combined reasons in stable order", () => {
    const u: BtcUtxo = {
      txid: "x",
      vout: 0,
      value: 1000,
      inscriptions: [{ id: "a" }, { id: "b" }],
      runes: [{ rune_id: "1:1", spaced_name: "R", amount: "5" }],
      risky_runes: [{ rune_id: "2:2", spaced_name: "P", amount: "10" }]
    };
    expect(reasonsForUtxo(u)).toEqual([
      { kind: "inscription", count: 2 },
      { kind: "rune", count: 1 },
      { kind: "risky_rune", count: 1 }
    ]);
  });
});

describe("partitionByProtection", () => {
  it("returns everything as spendable on a pure plain-UTXO list", () => {
    const r = partitionByProtection([plain(100), plain(200), plain(300)]);
    expect(r.spendable).toHaveLength(3);
    expect(r.protected_).toHaveLength(0);
    expect(r.spendableSats).toBe(600);
    expect(r.protectedSats).toBe(0);
  });

  it("splits inscribed UTXOs out", () => {
    const r = partitionByProtection([
      plain(1000),
      inscribed(546, "ins1"),
      plain(2000),
      inscribed(546, "ins2")
    ]);
    expect(r.spendable.map((u) => u.value)).toEqual([1000, 2000]);
    expect(r.protected_.map((u) => u.value)).toEqual([546, 546]);
    expect(r.spendableSats).toBe(3000);
    expect(r.protectedSats).toBe(1092);
  });

  it("splits mixed inscribed + runed + risky + plain correctly", () => {
    const r = partitionByProtection([
      plain(50_000),
      inscribed(546),
      runed(546, "r1"),
      riskyRuned(546, "rr1"),
      plain(25_000)
    ]);
    expect(r.spendable).toHaveLength(2);
    expect(r.protected_).toHaveLength(3);
    expect(r.spendableSats).toBe(75_000);
    expect(r.protectedSats).toBe(1638);
  });

  it("handles all-protected case (returns empty spendable)", () => {
    const r = partitionByProtection([inscribed(546), runed(546, "r1")]);
    expect(r.spendable).toHaveLength(0);
    expect(r.protected_).toHaveLength(2);
    expect(r.spendableSats).toBe(0);
    expect(r.protectedSats).toBe(1092);
  });

  it("handles empty input", () => {
    const r = partitionByProtection([]);
    expect(r.spendable).toHaveLength(0);
    expect(r.protected_).toHaveLength(0);
    expect(r.spendableSats).toBe(0);
    expect(r.protectedSats).toBe(0);
  });
});
