import { describe, it, expect } from "vitest";
import { formatSwapAmount, formatSwapBalance } from "../format";

/**
 * Pins the Swap surface's display rules. Earlier the Swap cards used
 * `toFixed(decimals)` which dropped thousands separators entirely
 * ("99696.00" instead of "99,696.00"), making large balances hard to
 * scan at a glance.
 */
describe("formatSwapAmount", () => {
  it("uses thousands separators for large USDC amounts", () => {
    // en-US is the de-facto CI locale; if vitest is ever pointed at
    // a non-en locale the comma will become the locale's group
    // separator, which is the desired behaviour.
    expect(formatSwapAmount(99696, "USDC")).toBe("99,696.00");
    expect(formatSwapAmount(1_234_567.89, "USDC")).toBe("1,234,567.89");
  });

  it("keeps 8 decimals for BTC-family balances", () => {
    expect(formatSwapAmount(1.00398973, "aBTC")).toBe("1.00398973");
    expect(formatSwapAmount(0.5, "BTC")).toBe("0.50000000");
  });

  it("collapses zero / negative / non-finite to a bare \"0\"", () => {
    expect(formatSwapAmount(0, "USDC")).toBe("0");
    expect(formatSwapAmount(-1, "USDC")).toBe("0");
    expect(formatSwapAmount(NaN, "USDC")).toBe("0");
    expect(formatSwapAmount(Infinity, "USDC")).toBe("0");
  });
});

describe("formatSwapBalance", () => {
  it("appends the symbol after a thousands-separated amount", () => {
    expect(formatSwapBalance(99696, "USDC")).toBe("99,696.00 USDC");
    expect(formatSwapBalance(1.00398973, "aBTC")).toBe("1.00398973 aBTC");
  });

  it("renders zero as \"0 SYMBOL\"", () => {
    expect(formatSwapBalance(0, "USDC")).toBe("0 USDC");
    expect(formatSwapBalance(0, "aBTC")).toBe("0 aBTC");
  });
});
