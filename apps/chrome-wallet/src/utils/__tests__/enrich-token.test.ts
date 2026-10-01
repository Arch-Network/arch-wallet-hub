import { describe, expect, it } from "vitest";

import { isNftToken, isRawNftCandidate } from "../enrich-token";

describe("isNftToken", () => {
  it("recognizes image-backed one-of-one zero-decimal tokens", () => {
    expect(isNftToken({ image: "https://example.com/nft.png", decimals: 0, balance: 1 })).toBe(true);
  });

  it("rejects fungible and image-less tokens", () => {
    expect(isNftToken({ image: "https://example.com/token.png", decimals: 6, balance: 1 })).toBe(false);
    expect(isNftToken({ image: "https://example.com/token.png", decimals: 0, balance: 2 })).toBe(false);
    expect(isNftToken({ image: undefined, decimals: 0, balance: 1 })).toBe(false);
  });
});

describe("isRawNftCandidate", () => {
  it("filters NFT candidates before expensive enrichment", () => {
    expect(
      isRawNftCandidate({
        image: "https://example.com/nft.png",
        decimals: 0,
        amount: "1",
      }),
    ).toBe(true);
    expect(
      isRawNftCandidate({
        image: "https://example.com/token.png",
        decimals: 6,
        amount: "1",
      }),
    ).toBe(false);
  });
});
