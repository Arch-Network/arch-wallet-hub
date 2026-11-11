import { describe, expect, it } from "vitest";
import {
  ArchAccountTokensResponse,
  safeParseOr,
} from "../indexer-types";

describe("ArchAccountTokensResponse", () => {
  it("parses a token list and defaults a missing one", () => {
    expect(ArchAccountTokensResponse.parse({}).tokens).toEqual([]);
    const parsed = ArchAccountTokensResponse.parse({
      tokens: [{ mint_address: "mint" }],
    });
    expect(parsed.tokens[0]).toMatchObject({
      mint_address: "mint",
      amount: "0",
      decimals: 0,
    });
  });

  it("rejects an oversized token list before trusting it", () => {
    const tokens = Array.from({ length: 10_001 }, () => ({
      mint_address: "mint",
    }));
    expect(ArchAccountTokensResponse.safeParse({ tokens }).success).toBe(false);
    expect(safeParseOr(ArchAccountTokensResponse, { tokens }, { tokens: [] })).toEqual({
      tokens: [],
    });
  });
});
