import { describe, expect, it } from "vitest";
import {
  btcInputToUsd,
  rawTokenAmountToInput,
  usdInputToBtc,
} from "../send-amounts";

describe("BTC/USD send amount conversion", () => {
  it("converts a USD input to BTC rounded to whole satoshis", () => {
    expect(usdInputToBtc("100", 50_000)).toBe("0.002");
    expect(usdInputToBtc("1", 100_000)).toBe("0.00001");
  });

  it("converts a BTC input to a numeric USD input", () => {
    expect(btcInputToUsd("0.002", 50_000)).toBe("100.00");
    expect(btcInputToUsd("0.000001", 50_000)).toBe("0.0500");
  });

  it("returns an empty conversion when input or price is unavailable", () => {
    expect(usdInputToBtc("", 50_000)).toBe("");
    expect(usdInputToBtc("100", null)).toBe("");
    expect(btcInputToUsd("1", 0)).toBe("");
  });
});

describe("rawTokenAmountToInput", () => {
  it("formats token balances without locale separators", () => {
    expect(rawTokenAmountToInput("100000000", 6)).toBe("100");
    expect(rawTokenAmountToInput("1234500", 6)).toBe("1.2345");
  });

  it("preserves balances larger than Number.MAX_SAFE_INTEGER", () => {
    expect(rawTokenAmountToInput("9007199254740993000", 9)).toBe(
      "9007199254.740993",
    );
  });

  it("supports balances smaller than one whole token", () => {
    expect(rawTokenAmountToInput("1", 8)).toBe("0.00000001");
  });

  it("rejects malformed raw balances", () => {
    expect(rawTokenAmountToInput("1,000", 2)).toBe("");
  });
});
