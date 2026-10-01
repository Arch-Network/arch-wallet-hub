import { describe, it, expect } from "vitest";
import { parseU64DecimalString, U64_MAX } from "../u64-amount";
import { formatArch } from "../format";

/**
 * Strings the Hub's `BigInt()` would read as a real amount while
 * `parseInt(x, 10)` reads 0 (or a different number) -- the gap that let
 * a dapp display "0 ARCH" for a transfer of 10 ARCH.
 */
const INVALID_AMOUNT_STRINGS: Array<[string, string]> = [
  ["hex", "0x2540BE400"],
  ["binary", "0b1001010100000010111110010000000000"],
  ["octal", "0o112402762000"],
  ["negative", "-1"],
  ["leading whitespace", " 1000000000"],
  ["trailing whitespace", "1000000000 "],
  ["newline", "\n1000000000"],
  ["explicit plus", "+5"],
  ["exponent", "1e10"],
  ["decimal point", "1.5"],
  ["empty", ""],
  ["2^64 (one past u64)", "18446744073709551616"],
  ["21 digits", "000000000000000000001"],
];

describe("parseU64DecimalString", () => {
  it.each(INVALID_AMOUNT_STRINGS)("rejects %s (%j)", (_label, raw) => {
    expect(parseU64DecimalString(raw)).toBeNull();
  });

  it("accepts 2^64-1 exactly", () => {
    expect(parseU64DecimalString("18446744073709551615")).toBe(U64_MAX);
    expect(U64_MAX).toBe(2n ** 64n - 1n);
  });

  it("accepts plain decimal digits", () => {
    expect(parseU64DecimalString("0")).toBe(0n);
    expect(parseU64DecimalString("10000000000")).toBe(10_000_000_000n);
  });

  it("rejects non-string inputs, including numbers", () => {
    for (const raw of [5, 5n, null, undefined, {}, ["5"]]) {
      expect(parseU64DecimalString(raw)).toBeNull();
    }
  });
});

describe("formatArch", () => {
  it.each(INVALID_AMOUNT_STRINGS)("renders %s (%j) as invalid, never as a number", (_label, raw) => {
    expect(formatArch(raw)).toBe("Invalid amount");
  });

  it("renders 2^64-1 lamports exactly", () => {
    expect(formatArch("18446744073709551615")).toBe("18446744073.7096 ARCH");
  });

  it("keeps the X.XXXX ARCH format for valid amounts", () => {
    expect(formatArch("0")).toBe("0.0000 ARCH");
    expect(formatArch("10000000000")).toBe("10.0000 ARCH");
    expect(formatArch("123456789")).toBe("0.1235 ARCH");
    expect(formatArch("49999")).toBe("0.0000 ARCH");
    expect(formatArch("50000")).toBe("0.0001 ARCH");
    expect(formatArch(1_500_000_000)).toBe("1.5000 ARCH");
    expect(formatArch(0)).toBe("0.0000 ARCH");
  });

  it("renders non-integer or negative numbers as invalid", () => {
    for (const n of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatArch(n)).toBe("Invalid amount");
    }
  });
});
