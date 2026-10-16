import { describe, it, expect } from "vitest";
import { summarizeArchTx, type TokenDisplayInfo } from "../arch-tx-summary";

const ME = "UserArchAddr11111111111111111111";
const MY_ATA = "UserUsdcAta111111111111111111111";
const OTHER = "OtherAddr1111111111111111111111";
const OTHER_ATA = "OtherAta11111111111111111111111";
const USDC: TokenDisplayInfo = {
  tokenAccount: MY_ATA,
  mint: "UsdcMint11111111111111111111111",
  symbol: "USDC",
  decimals: 6,
};

describe("summarizeArchTx amounts", () => {
  it("reads wrapped lamports from a decoded System Transfer", () => {
    const s = summarizeArchTx(
      {
        instructions: [{
          action: "System: Transfer",
          decoded: { lamports: { type: "u64", data: 1_500_000_000 }, source: OTHER, destination: ME },
        }],
      },
      ME,
    );
    expect(s.label).toBe("Received ARCH");
    expect(s.amountLabel).toBe("+1.5 ARCH");
  });

  it("resolves symbol + decimals for a Token: Transfer with a numeric amount", () => {
    const s = summarizeArchTx(
      {
        instructions: [{
          action: "Token: Transfer",
          decoded: { type: "transfer", amount: 12_500_000, from: MY_ATA, to: OTHER_ATA, authority: ME },
        }],
      },
      ME,
      { tokenAccounts: [MY_ATA], tokens: [USDC] },
    );
    expect(s.label).toBe("Sent USDC");
    expect(s.amountLabel).toBe("-12.5 USDC");
  });

  it("resolves the token by mint on a v2 token_transfer row", () => {
    const s = summarizeArchTx(
      {
        token_transfer: {
          source_account: OTHER_ATA,
          destination_account: MY_ATA,
          destination_owner: ME,
          amount: "250000",
          decimals: 6,
          mint: USDC.mint,
        },
      },
      ME,
      { tokens: [USDC] },
    );
    expect(s.label).toBe("Received USDC");
    expect(s.amountLabel).toBe("+0.25 USDC");
  });

  it("still shows a raw amount when the token is unknown", () => {
    const s = summarizeArchTx(
      {
        instructions: [{
          action: "Token: Transfer",
          decoded: { type: "transfer", amount: 42, from: MY_ATA, to: OTHER_ATA, authority: ME },
        }],
      },
      ME,
      { tokenAccounts: [MY_ATA] },
    );
    expect(s.label).toBe("Sent Token");
    expect(s.amountLabel).toBe("-42");
  });
});
