import { describe, it, expect } from "vitest";
import {
  formatMaxAmount,
  formatSwapAmount,
  formatSwapBalance,
  formatSwapRate,
  swapPrecision,
} from "../format";
import { isDollarPegged } from "../token-usd";

/**
 * Pins the Swap surface's display rules. Earlier the Swap cards used
 * `toFixed(decimals)` which dropped thousands separators entirely
 * ("99696.00" instead of "99,696.00"), making large balances hard to
 * scan at a glance.
 */
describe("formatSwapAmount", () => {
  it("uses thousands separators for large dollar amounts", () => {
    // en-US is the de-facto CI locale; if vitest is ever pointed at
    // a non-en locale the comma will become the locale's group
    // separator, which is the desired behaviour.
    expect(formatSwapAmount(99696, 2)).toBe("99,696.00");
    expect(formatSwapAmount(1_234_567.89, 2)).toBe("1,234,567.89");
  });

  it("keeps 8 decimals for BTC-family balances", () => {
    expect(formatSwapAmount(1.00398973, 8)).toBe("1.00398973");
    expect(formatSwapAmount(0.5, 8)).toBe("0.50000000");
  });

  it("collapses zero / negative / non-finite to a bare \"0\"", () => {
    expect(formatSwapAmount(0, 2)).toBe("0");
    expect(formatSwapAmount(-1, 2)).toBe("0");
    expect(formatSwapAmount(NaN, 2)).toBe("0");
    expect(formatSwapAmount(Infinity, 2)).toBe("0");
  });

  it("never rounds a positive amount down to zero", () => {
    expect(formatSwapAmount(0.004, 2)).toBe("<0.01");
    expect(formatSwapAmount(0.000001, 2)).toBe("<0.01");
    expect(formatSwapAmount(0.000000004, 8)).toBe("<0.00000001");
    // The smallest amount that fits is shown as itself.
    expect(formatSwapAmount(0.01, 2)).toBe("0.01");
  });

  it("extends to the token's full precision when asked", () => {
    expect(formatSwapAmount(0.004, 2, 6)).toBe("0.004");
    expect(formatSwapAmount(98_699.03604, 2, 6)).toBe("98,699.03604");
    // Whole amounts keep the card's two places rather than padding out.
    expect(formatSwapAmount(98_699, 2, 6)).toBe("98,699.00");
    // Below one atomic unit there is nothing left to show.
    expect(formatSwapAmount(0.0000004, 2, 6)).toBe("<0.000001");
  });
});

describe("formatSwapBalance", () => {
  it("appends the symbol after a thousands-separated amount", () => {
    expect(formatSwapBalance(99696, "aUSD", 2)).toBe("99,696.00 aUSD");
    expect(formatSwapBalance(1.00398973, "aBTC", 8)).toBe("1.00398973 aBTC");
  });

  it("renders zero as \"0 SYMBOL\"", () => {
    expect(formatSwapBalance(0, "aUSD", 2)).toBe("0 aUSD");
    expect(formatSwapBalance(0, "aBTC", 8)).toBe("0 aBTC");
  });
});

describe("swapPrecision", () => {
  it("reads dollar-pegged tokens as money, whatever they are labelled", () => {
    // Testnet USDC and mainnet USDT both display as "aUSD"; the peg is
    // read off the engine symbol, so the label cannot break it.
    expect(swapPrecision(6, isDollarPegged("USDC"))).toEqual({ display: 2, full: 6 });
    expect(swapPrecision(6, isDollarPegged("USDT"))).toEqual({ display: 2, full: 6 });
  });

  it("shows other tokens at their on-chain precision", () => {
    expect(swapPrecision(8, isDollarPegged("BTC"))).toEqual({ display: 8, full: 8 });
    expect(swapPrecision(6, false)).toEqual({ display: 6, full: 6 });
  });

  it("caps the cards at 8 places but keeps the full precision for review", () => {
    expect(swapPrecision(9, false)).toEqual({ display: 8, full: 9 });
    expect(swapPrecision(9, true)).toEqual({ display: 2, full: 9 });
  });

  it("never shows more places than the token has", () => {
    expect(swapPrecision(0, true)).toEqual({ display: 0, full: 0 });
    expect(swapPrecision(1, true)).toEqual({ display: 1, full: 1 });
    expect(swapPrecision(Number.NaN, false)).toEqual({ display: 0, full: 0 });
  });
});

describe("formatSwapRate", () => {
  it("reads large rates as prices", () => {
    expect(formatSwapRate(71_853.4567)).toBe("71,853.46");
    expect(formatSwapRate(100)).toBe("100.00");
  });

  it("keeps six decimals between 1 and 100", () => {
    expect(formatSwapRate(1.0002)).toBe("1.000200");
    expect(formatSwapRate(42.5)).toBe("42.500000");
  });

  it("keeps the meaningful digits of an inverse rate", () => {
    // Six decimal places would cut this to 0.000014.
    expect(formatSwapRate(1.38748555 / 99_696.123456)).toBe("0.0000139171");
    expect(formatSwapRate(0.5)).toBe("0.5");
  });

  it("has nothing to show without a rate", () => {
    expect(formatSwapRate(0)).toBe("—");
    expect(formatSwapRate(Number.NaN)).toBe("—");
  });
});

describe("formatMaxAmount", () => {
  it("spends the whole balance without rounding past it", () => {
    // Two places would round this to 11.00, more than the wallet holds.
    expect(formatMaxAmount(10.999999, 6)).toBe("10.999999");
    expect(Number(formatMaxAmount(10.999999, 6))).toBeLessThanOrEqual(10.999999);
    // Two places would round this to 0.00, an empty amount.
    expect(formatMaxAmount(0.004, 6)).toBe("0.004");
  });

  it("round-trips a balance built from atomic units", () => {
    const atomic = 100_398_973;
    expect(formatMaxAmount(atomic / 10 ** 8, 8)).toBe("1.00398973");
    expect(formatMaxAmount(1 / 10 ** 9, 9)).toBe("0.000000001");
  });

  it("drops trailing zeros but not significant ones", () => {
    expect(formatMaxAmount(0.5, 8)).toBe("0.5");
    expect(formatMaxAmount(100, 6)).toBe("100");
    expect(formatMaxAmount(1200, 0)).toBe("1200");
  });

  it("is empty when there is nothing to spend", () => {
    expect(formatMaxAmount(0, 6)).toBe("");
    expect(formatMaxAmount(Number.NaN, 6)).toBe("");
  });
});
