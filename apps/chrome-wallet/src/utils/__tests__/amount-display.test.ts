import { describe, expect, it } from "vitest";
import {
  ARCH_DECIMALS,
  formatBaseUnits,
  formatSatsAsBtc,
  formatTokenAmountDisplay,
  groupAddress,
} from "../amount-display";
import { U64_MAX } from "../u64-amount";

const flat = (groups: ReturnType<typeof groupAddress>) =>
  groups.map((runs) => runs.map((r) => (r.strong ? `[${r.text}]` : r.text)).join(""));

describe("formatBaseUnits", () => {
  it("scales without rounding and trims trailing zeros", () => {
    expect(formatBaseUnits(2_500_000_000n, ARCH_DECIMALS)).toBe("2.5");
    expect(formatBaseUnits(1n, ARCH_DECIMALS)).toBe("0.000000001");
    expect(formatBaseUnits(40_000n, ARCH_DECIMALS)).toBe("0.00004");
    expect(formatBaseUnits(3_000_000_000n, ARCH_DECIMALS)).toBe("3");
    expect(formatBaseUnits(0n, 6)).toBe("0");
  });

  it("groups thousands in the whole part only", () => {
    expect(formatBaseUnits(123_456_789_012n, 6)).toBe("123,456.789012");
    expect(formatBaseUnits(1_234_567n, 0)).toBe("1,234,567");
  });

  it("is exact at u64 max, where float math would not be", () => {
    expect(formatBaseUnits(U64_MAX, 0)).toBe("18,446,744,073,709,551,615");
    expect(formatBaseUnits(U64_MAX, 9)).toBe("18,446,744,073.709551615");
  });

  it("keeps the sign of negative amounts", () => {
    expect(formatBaseUnits(-129_424n, 8)).toBe("-0.00129424");
  });

  it.each([-1, 1.5, 37, Number.NaN])("rejects decimals %s", (decimals) => {
    expect(() => formatBaseUnits(1n, decimals)).toThrow();
  });
});

describe("formatSatsAsBtc", () => {
  it("converts integer sats exactly", () => {
    expect(formatSatsAsBtc(120_000)).toBe("0.0012");
    expect(formatSatsAsBtc(924)).toBe("0.00000924");
    expect(formatSatsAsBtc(2_100_000_000_000_000)).toBe("21,000,000");
  });

  it("returns null for values that are not safe integers", () => {
    expect(formatSatsAsBtc(1.5)).toBeNull();
    expect(formatSatsAsBtc(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
    expect(formatSatsAsBtc(Number.NaN)).toBeNull();
  });
});

describe("formatTokenAmountDisplay", () => {
  it("scales by known decimals and carries the symbol", () => {
    expect(formatTokenAmountDisplay(1_500_000n, { decimals: 6, symbol: "USDC" })).toEqual({
      kind: "scaled",
      amount: "1.5",
      symbol: "USDC",
    });
    expect(formatTokenAmountDisplay(150_000_000n, { decimals: 8, symbol: "aBTC" })).toEqual({
      kind: "scaled",
      amount: "1.5",
      symbol: "aBTC",
    });
  });

  it("falls back to unscaled raw units with no metadata", () => {
    expect(formatTokenAmountDisplay(1_500_000n, null)).toEqual({ kind: "raw", amount: "1,500,000" });
  });

  it.each([
    ["negative decimals", { decimals: -1, symbol: "X" }],
    ["fractional decimals", { decimals: 2.5, symbol: "X" }],
    ["absurd decimals", { decimals: 99, symbol: "X" }],
    ["blank symbol", { decimals: 6, symbol: "  " }],
  ])("falls back to raw units for %s", (_label, meta) => {
    expect(formatTokenAmountDisplay(1_500_000n, meta)).toEqual({ kind: "raw", amount: "1,500,000" });
  });
});

describe("groupAddress", () => {
  it("groups in fours and marks the first and last six characters", () => {
    expect(flat(groupAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"))).toEqual([
      "[tb1q]",
      "[w5]08",
      "d6qe",
      "jxtd",
      "g4y5",
      "r3za",
      "rvar",
      "y0c5",
      "xw7k",
      "[xpjz]",
      "[sx]",
    ]);
  });

  it("round-trips the address exactly", () => {
    const address = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const joined = groupAddress(address)
      .flat()
      .map((r) => r.text)
      .join("");
    expect(joined).toBe(address);
  });

  it("marks everything strong when the address is shorter than both ends", () => {
    expect(flat(groupAddress("abcdefghij"))).toEqual(["[abcd]", "[efgh]", "[ij]"]);
  });

  it("returns no groups for an empty address", () => {
    expect(groupAddress("")).toEqual([]);
  });
});
