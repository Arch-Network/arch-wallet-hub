import { describe, it, expect } from "vitest";
import {
  computeArchTransferGate,
  computeTokenTransferGate,
  computeArchSpendCapGate,
} from "../transfer-gates";
import { parseU64DecimalString } from "../u64-amount";

const INVALID_AMOUNT_STRINGS = [
  "0x2540BE400",
  "0b1001010100000010111110010000000000",
  "0o112402762000",
  "-1",
  " 1000",
  "1000 ",
  "+5",
  "1e10",
  "",
  "18446744073709551616",
];

const BIG_BALANCE = 10n ** 18n;

describe("gates fail closed on unparseable dapp amounts", () => {
  it.each(INVALID_AMOUNT_STRINGS)("ARCH balance gate refuses %j", (raw) => {
    const gate = computeArchTransferGate(
      { kind: "found", lamports: BIG_BALANCE },
      parseU64DecimalString(raw),
      5_000n,
    );
    expect(gate.state).toBe("invalid-amount");
  });

  it.each(INVALID_AMOUNT_STRINGS)("ARCH balance gate refuses %j even when balance is unknown", (raw) => {
    for (const snapshot of [
      { kind: "not_found" as const },
      { kind: "error" as const, reason: "timeout" },
    ]) {
      expect(computeArchTransferGate(snapshot, parseU64DecimalString(raw), 5_000n).state).toBe(
        "invalid-amount",
      );
    }
  });

  it.each(INVALID_AMOUNT_STRINGS)("token balance gate refuses %j", (raw) => {
    const found = computeTokenTransferGate(
      { kind: "found", amount: BIG_BALANCE },
      parseU64DecimalString(raw),
    );
    expect(found.state).toBe("invalid-amount");
    const missing = computeTokenTransferGate({ kind: "not_found" }, parseU64DecimalString(raw));
    expect(missing.state).toBe("invalid-amount");
  });

  it.each(INVALID_AMOUNT_STRINGS)("spend-cap gate refuses %j without consulting the cap", async (raw) => {
    let capReads = 0;
    const gate = await computeArchSpendCapGate({
      requestedLamports: parseU64DecimalString(raw),
      readCapLamports: async () => {
        capReads++;
        return undefined;
      },
      readRecentLamports: async () => 0n,
    });
    expect(gate.state).toBe("invalid-amount");
    expect(capReads).toBe(0);
  });

  it("accepts 2^64-1 and gates it on balance like any other amount", async () => {
    const max = parseU64DecimalString("18446744073709551615");
    expect(computeArchTransferGate({ kind: "found", lamports: BIG_BALANCE }, max, 5_000n).state).toBe(
      "blocked",
    );
    expect(
      computeTokenTransferGate({ kind: "found", amount: BIG_BALANCE }, max)
        .state,
    ).toBe("blocked");
    const cap = await computeArchSpendCapGate({
      requestedLamports: max,
      readCapLamports: async () => 1_000_000,
      readRecentLamports: async () => 0n,
    });
    expect(cap.state).toBe("cap-blocked");
  });
});

describe("computeTokenTransferGate", () => {
  it("still allows a zero-amount transfer through to the Hub", () => {
    const gate = computeTokenTransferGate({ kind: "found", amount: 5n }, 0n);
    expect(gate).toEqual({
      state: "ok",
      snapshot: { kind: "found", amount: 5n },
      postAmount: 5n,
    });
  });

  it("blocks when requested exceeds the token balance", () => {
    const gate = computeTokenTransferGate({ kind: "found", amount: 5n }, 6n);
    expect(gate.state).toBe("blocked");
  });
});

describe("computeArchSpendCapGate", () => {
  it("does not enforce when no cap is configured", async () => {
    const gate = await computeArchSpendCapGate({
      requestedLamports: 10n,
      readCapLamports: async () => undefined,
      readRecentLamports: async () => 0n,
    });
    expect(gate.state).toBe("ok");
  });

  it("blocks when recent + pending exceeds the cap", async () => {
    const gate = await computeArchSpendCapGate({
      requestedLamports: 600n,
      readCapLamports: async () => 1_000,
      readRecentLamports: async () => 500n,
    });
    expect(gate).toEqual({ state: "cap-blocked", capLamports: 1_000n, recentLamports: 500n });
  });
});
