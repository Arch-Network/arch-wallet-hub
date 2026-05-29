/**
 * Rune coin selection tests.
 *
 * Pin every error path and every accumulation invariant because
 * a coin-selection bug in the rune-send flow doesn't just produce
 * a bad UX -- it produces a runestone with wrong edict math and
 * BURNS the user's runes irrecoverably.
 *
 * The pure-logic shape of the module means we can hammer it with
 * adversarial UTXO configurations without any bitcoinjs / network
 * mocking.
 */
import { describe, it, expect } from "vitest";
import type { BtcUtxo } from "../indexer";
import {
  InsufficientBtcForRuneSendError,
  InsufficientRuneBalanceError,
  getRuneBalanceOnUtxo,
  selectUtxosForRuneSend
} from "../rune-coin-select";

const RUNE_A = "73393:191";
const RUNE_B = "100:5";

function utxo(
  txid: string,
  vout: number,
  value: number,
  extras: {
    runes?: Array<{ rune_id: string; amount: string }>;
    risky_runes?: Array<{ rune_id: string; amount: string }>;
    inscriptions?: Array<{ id: string }>;
  } = {}
): BtcUtxo {
  return {
    txid,
    vout,
    value,
    status: { confirmed: true },
    ...extras
  } as BtcUtxo;
}

describe("getRuneBalanceOnUtxo", () => {
  it("returns 0n for plain BTC UTXO", () => {
    expect(getRuneBalanceOnUtxo(utxo("t", 0, 10000), RUNE_A)).toBe(0n);
  });

  it("returns the amount when the UTXO carries the target rune", () => {
    const u = utxo("t", 0, 546, {
      runes: [{ rune_id: RUNE_A, amount: "100" }]
    });
    expect(getRuneBalanceOnUtxo(u, RUNE_A)).toBe(100n);
  });

  it("ignores other runes on the same UTXO", () => {
    const u = utxo("t", 0, 546, {
      runes: [
        { rune_id: RUNE_B, amount: "999" },
        { rune_id: RUNE_A, amount: "50" }
      ]
    });
    expect(getRuneBalanceOnUtxo(u, RUNE_A)).toBe(50n);
  });

  it("sums multiple entries of the same rune (defensive)", () => {
    const u = utxo("t", 0, 546, {
      runes: [
        { rune_id: RUNE_A, amount: "30" },
        { rune_id: RUNE_A, amount: "70" }
      ]
    });
    expect(getRuneBalanceOnUtxo(u, RUNE_A)).toBe(100n);
  });

  it("handles u128 amounts without precision loss", () => {
    const u128Str = "340282366920938463463374607431768211455"; // 2^128 - 1
    const u = utxo("t", 0, 546, {
      runes: [{ rune_id: RUNE_A, amount: u128Str }]
    });
    expect(getRuneBalanceOnUtxo(u, RUNE_A)).toBe(BigInt(u128Str));
  });

  it("ignores malformed amount strings", () => {
    const u = utxo("t", 0, 546, {
      runes: [{ rune_id: RUNE_A, amount: "not-a-number" }]
    });
    expect(getRuneBalanceOnUtxo(u, RUNE_A)).toBe(0n);
  });
});

describe("selectUtxosForRuneSend — happy path", () => {
  it("selects a single UTXO when it covers the target amount", () => {
    const utxos = [
      utxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] }),
      utxo("b", 0, 100000) // plain BTC for fees
    ];
    const r = selectUtxosForRuneSend({
      utxos,
      targetRuneId: RUNE_A,
      targetAmount: 50n,
      recipientDustSats: 546,
      changeDustSats: 546,
      feeSats: 500
    });
    expect(r.runedInputs).toHaveLength(1);
    expect(r.runedInputs[0]!.txid).toBe("a");
    expect(r.targetRuneTotal).toBe(100n);
    expect(r.leftoverRune).toBe(50n);
    expect(r.btcInputs).toHaveLength(1);
    expect(r.btcInputs[0]!.txid).toBe("b");
  });

  it("picks largest-rune-amount first to minimize input count", () => {
    const utxos = [
      utxo("small", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "10" }] }),
      utxo("big",   0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] }),
      utxo("mid",   0, 546, { runes: [{ rune_id: RUNE_A, amount: "50" }] }),
      utxo("btc",   0, 100000)
    ];
    const r = selectUtxosForRuneSend({
      utxos,
      targetRuneId: RUNE_A,
      targetAmount: 60n,
      recipientDustSats: 546,
      changeDustSats: 546,
      feeSats: 500
    });
    // Largest (100) alone covers 60, so only 1 runed input.
    expect(r.runedInputs).toHaveLength(1);
    expect(r.runedInputs[0]!.txid).toBe("big");
    expect(r.targetRuneTotal).toBe(100n);
    expect(r.leftoverRune).toBe(40n);
  });

  it("aggregates multiple runed UTXOs when target exceeds the largest", () => {
    const utxos = [
      utxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "40" }] }),
      utxo("b", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "30" }] }),
      utxo("c", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "20" }] }),
      utxo("btc", 0, 100000)
    ];
    const r = selectUtxosForRuneSend({
      utxos,
      targetRuneId: RUNE_A,
      targetAmount: 60n,
      recipientDustSats: 546,
      changeDustSats: 546,
      feeSats: 500
    });
    // 40 + 30 = 70 >= 60
    expect(r.runedInputs).toHaveLength(2);
    expect(r.targetRuneTotal).toBe(70n);
    expect(r.leftoverRune).toBe(10n);
  });

  it("zero leftover when target exactly matches a single UTXO", () => {
    const utxos = [
      utxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] }),
      utxo("btc", 0, 100000)
    ];
    const r = selectUtxosForRuneSend({
      utxos,
      targetRuneId: RUNE_A,
      targetAmount: 100n,
      recipientDustSats: 546,
      changeDustSats: 546,
      feeSats: 500
    });
    expect(r.leftoverRune).toBe(0n);
  });
});

describe("selectUtxosForRuneSend — protection invariants", () => {
  it("SKIPS UTXOs that carry inscriptions even if they have the rune", () => {
    // An inscription + rune on the same output is rare but possible.
    // We must not spend that UTXO -- the inscription would burn.
    const utxos = [
      utxo("inscribed", 0, 546, {
        runes: [{ rune_id: RUNE_A, amount: "100" }],
        inscriptions: [{ id: "abc:0i0" }]
      }),
      utxo("btc", 0, 100000)
    ];
    expect(() =>
      selectUtxosForRuneSend({
        utxos,
        targetRuneId: RUNE_A,
        targetAmount: 50n,
        recipientDustSats: 546,
        changeDustSats: 546,
        feeSats: 500
      })
    ).toThrow(InsufficientRuneBalanceError);
  });

  it("SKIPS UTXOs with risky_runes (mempool-pending) -- avoids re-org/replace risk", () => {
    const utxos = [
      utxo("risky", 0, 546, {
        runes: [{ rune_id: RUNE_A, amount: "100" }],
        risky_runes: [{ rune_id: RUNE_A, amount: "100" }]
      }),
      utxo("btc", 0, 100000)
    ];
    expect(() =>
      selectUtxosForRuneSend({
        utxos,
        targetRuneId: RUNE_A,
        targetAmount: 50n,
        recipientDustSats: 546,
        changeDustSats: 546,
        feeSats: 500
      })
    ).toThrow(InsufficientRuneBalanceError);
  });

  it("does NOT use other-rune UTXOs as plain BTC top-up", () => {
    // UTXO 'b' has rune B (not the target). It must NOT be pulled in as
    // BTC fee fodder -- spending it would burn its rune B balance.
    const utxos = [
      utxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] }),
      utxo("b", 0, 5000, { runes: [{ rune_id: RUNE_B, amount: "999" }] }),
      utxo("plain", 0, 2000)
    ];
    const r = selectUtxosForRuneSend({
      utxos,
      targetRuneId: RUNE_A,
      targetAmount: 50n,
      recipientDustSats: 546,
      changeDustSats: 546,
      feeSats: 500
    });
    // Only 'a' (runed) + 'plain' (BTC). 'b' is filtered out.
    expect(r.btcInputs.map((u) => u.txid)).toEqual(["plain"]);
  });
});

describe("selectUtxosForRuneSend — error paths", () => {
  it("throws InsufficientRuneBalanceError with the true pool total", () => {
    const utxos = [
      utxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "10" }] }),
      utxo("b", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "20" }] })
    ];
    try {
      selectUtxosForRuneSend({
        utxos,
        targetRuneId: RUNE_A,
        targetAmount: 100n,
        recipientDustSats: 546,
        changeDustSats: 546,
        feeSats: 500
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientRuneBalanceError);
      expect((err as InsufficientRuneBalanceError).have).toBe(30n);
      expect((err as InsufficientRuneBalanceError).need).toBe(100n);
      expect((err as InsufficientRuneBalanceError).code).toBe("INSUFFICIENT_RUNE_BALANCE");
    }
  });

  it("throws InsufficientBtcForRuneSendError when no BTC top-up is available", () => {
    // Runed UTXO has 546 sats; we need 546+546+5000 = 6092 sats total.
    // No other UTXOs available -> bail.
    const utxos = [
      utxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] })
    ];
    try {
      selectUtxosForRuneSend({
        utxos,
        targetRuneId: RUNE_A,
        targetAmount: 50n,
        recipientDustSats: 546,
        changeDustSats: 546,
        feeSats: 5000
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientBtcForRuneSendError);
      expect((err as InsufficientBtcForRuneSendError).code).toBe("INSUFFICIENT_BTC_FOR_RUNE_SEND");
    }
  });

  it("rejects targetAmount = 0n (would burn input runes)", () => {
    const utxos = [utxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] })];
    expect(() =>
      selectUtxosForRuneSend({
        utxos,
        targetRuneId: RUNE_A,
        targetAmount: 0n,
        recipientDustSats: 546,
        changeDustSats: 546,
        feeSats: 500
      })
    ).toThrow();
  });

  it("rejects negative targetAmount", () => {
    const utxos = [utxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] })];
    expect(() =>
      selectUtxosForRuneSend({
        utxos,
        targetRuneId: RUNE_A,
        targetAmount: -1n,
        recipientDustSats: 546,
        changeDustSats: 546,
        feeSats: 500
      })
    ).toThrow();
  });
});

describe("selectUtxosForRuneSend — u128 amounts", () => {
  it("handles u128-max targets without overflow", () => {
    const u128Max = (1n << 128n) - 1n;
    const utxos = [
      utxo("big", 0, 546, {
        runes: [{ rune_id: RUNE_A, amount: u128Max.toString() }]
      }),
      utxo("btc", 0, 100000)
    ];
    const r = selectUtxosForRuneSend({
      utxos,
      targetRuneId: RUNE_A,
      targetAmount: u128Max - 1n,
      recipientDustSats: 546,
      changeDustSats: 546,
      feeSats: 500
    });
    expect(r.targetRuneTotal).toBe(u128Max);
    expect(r.leftoverRune).toBe(1n);
  });
});
