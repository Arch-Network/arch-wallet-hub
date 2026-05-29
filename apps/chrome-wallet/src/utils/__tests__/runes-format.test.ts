/**
 * Tests for rune amount formatting.
 *
 * The math has to be done in BigInt -- any silent Number cast on a
 * 38-digit u128 amount produces wrong UI text and (worse) wrong
 * comparison results elsewhere. These tests pin the BigInt path
 * end-to-end across realistic and adversarial inputs.
 */
import { describe, it, expect } from "vitest";
import { formatRuneAmount, labelForRune } from "../runes-format";

describe("formatRuneAmount — small / common cases", () => {
  it("returns integer amounts verbatim when divisibility is 0", () => {
    expect(formatRuneAmount("100", 0)).toBe("100");
    expect(formatRuneAmount("1", 0)).toBe("1");
    expect(formatRuneAmount("0", 0)).toBe("0");
  });

  it("inserts decimal point at the right position for divisibility > 0", () => {
    expect(formatRuneAmount("1500000000000000000", 18)).toBe("1.5");
    expect(formatRuneAmount("123456789", 4)).toBe("12345.6789");
    expect(formatRuneAmount("1", 8)).toBe("0.00000001");
  });

  it("trims trailing zeros from the fractional part", () => {
    expect(formatRuneAmount("100000000", 8)).toBe("1");
    expect(formatRuneAmount("12300000", 6)).toBe("12.3");
    expect(formatRuneAmount("1000", 3)).toBe("1");
  });

  it("renders zero correctly at every divisibility", () => {
    expect(formatRuneAmount("0", 0)).toBe("0");
    expect(formatRuneAmount("0", 8)).toBe("0");
    expect(formatRuneAmount("0", 38)).toBe("0");
  });
});

describe("formatRuneAmount — u128 / large amounts (must use BigInt)", () => {
  it("handles u128 max without precision loss", () => {
    // u128 max = 2^128 - 1 = 340282366920938463463374607431768211455
    expect(
      formatRuneAmount("340282366920938463463374607431768211455", 0)
    ).toBe("340282366920938463463374607431768211455");
  });

  it("renders large mainnet-likely balances correctly", () => {
    // UNCOMMON*GOODS pre-mine ceiling per spec
    expect(
      formatRuneAmount("340282366920938463463374607431768211355", 0)
    ).toBe("340282366920938463463374607431768211355");
  });

  it("preserves the lowest digit (a Number cast would round here)", () => {
    // 9007199254740993 = Number.MAX_SAFE_INTEGER + 2; the last digit
    // matters and is exactly the case where a Number cast loses it.
    expect(formatRuneAmount("9007199254740993", 0)).toBe(
      "9007199254740993"
    );
  });
});

describe("formatRuneAmount — maxFractionDigits truncation", () => {
  it("truncates (round toward zero) when fraction exceeds cap", () => {
    expect(
      formatRuneAmount("123456789", 8, { maxFractionDigits: 4 })
    ).toBe("1.2345");
  });

  it("keeps full precision when cap is greater than divisibility", () => {
    expect(
      formatRuneAmount("150", 2, { maxFractionDigits: 8 })
    ).toBe("1.5");
  });

  it("never rounds up (conservative for balance display)", () => {
    // 0.99999999 with cap 4 -> 0.9999, NOT 1.0000
    expect(
      formatRuneAmount("99999999", 8, { maxFractionDigits: 4 })
    ).toBe("0.9999");
  });
});

describe("formatRuneAmount — defensive / parse-failure cases", () => {
  it("returns '0' on a non-numeric amount string", () => {
    expect(formatRuneAmount("not-a-number", 0)).toBe("0");
    expect(formatRuneAmount("", 0)).toBe("0");
    expect(formatRuneAmount("1.5", 0)).toBe("0"); // BigInt rejects decimals
  });

  it("tolerates hex amount strings (BigInt parses them; indexer never ships them)", () => {
    // BigInt("0xFF") === 255n. We accept this transparently because
    // rejecting it would require an extra regex; the indexer's
    // spec mandates decimal-only, so this branch is unreachable
    // in practice -- documenting via test so the next person
    // doesn't 'fix' the helper to reject hex without realizing.
    expect(formatRuneAmount("0xFF", 0)).toBe("255");
  });

  it("treats negative amounts as their absolute value (indexer never ships these)", () => {
    expect(formatRuneAmount("-100", 0)).toBe("100");
  });

  it("rounds non-integer divisibility down", () => {
    expect(formatRuneAmount("1500", 3.7)).toBe("1.5");
  });

  it("clamps negative divisibility to 0", () => {
    expect(formatRuneAmount("100", -2)).toBe("100");
  });
});

describe("labelForRune", () => {
  it("prefixes the symbol when present", () => {
    expect(
      labelForRune({ symbol: "\u29c9", spaced_name: "UNCOMMON\u2022GOODS" })
    ).toBe("\u29c9 UNCOMMON\u2022GOODS");
  });

  it("returns the spaced name alone when symbol is missing", () => {
    expect(
      labelForRune({ spaced_name: "BITCOIN\u2022RUNES" })
    ).toBe("BITCOIN\u2022RUNES");
  });

  it("returns the spaced name alone when symbol is empty/whitespace", () => {
    expect(
      labelForRune({ symbol: "   ", spaced_name: "FOO\u2022BAR" })
    ).toBe("FOO\u2022BAR");
  });
});
