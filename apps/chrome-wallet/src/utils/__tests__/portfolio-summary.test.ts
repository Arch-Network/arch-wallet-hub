import { describe, it, expect } from "vitest";
import { describePortfolio, type HoldingsSnapshot } from "../portfolio-summary";
import type { PortfolioValuation } from "../prices";

const snapshot = (overrides: Partial<HoldingsSnapshot>): HoldingsSnapshot => ({
  network: "mainnet",
  btcSats: 150_000,
  btcPartial: false,
  archLamports: 0,
  tokenCount: 0,
  ...overrides,
});

const valuation = (overrides: Partial<PortfolioValuation>): PortfolioValuation => ({
  btcUsd: 90,
  archUsd: 0,
  tokenUsd: 0,
  totalUsd: 90,
  btcPriced: true,
  archPriced: false,
  pricedAt: Date.now(),
  stale: false,
  tokenBreakdown: {},
  ...overrides,
});

describe("describePortfolio", () => {
  it("never values test assets in dollars", () => {
    const h = describePortfolio(snapshot({ network: "testnet4" }), valuation({}));
    expect(h.tone).toBe("test");
    expect(h.primary).toBe("0.00150000 BTC");
    expect(h.secondary).toBe("Test assets · no monetary value");
    expect(h.primary).not.toContain("$");
  });

  it("reports unavailable instead of zero when nothing could be read", () => {
    const h = describePortfolio(snapshot({ btcSats: null, archLamports: null }), null);
    expect(h.tone).toBe("unavailable");
    expect(h.primary).not.toMatch(/0/);
  });

  it("says so when one side couldn't be read", () => {
    const h = describePortfolio(snapshot({ btcSats: null, archLamports: 5 }), valuation({}));
    expect(h.notes).toContain("Bitcoin balance couldn't be loaded");
  });

  it("flags partially read Bitcoin addresses", () => {
    const h = describePortfolio(snapshot({ btcPartial: true }), valuation({}));
    expect(h.secondary).toBe("Partial value");
    expect(h.notes).toContain("Some Bitcoin addresses couldn't be loaded");
  });

  it("shows an empty account as empty", () => {
    const h = describePortfolio(snapshot({ btcSats: 0 }), valuation({ totalUsd: 0 }));
    expect(h).toMatchObject({ tone: "empty", secondary: "No assets yet" });
  });

  it("names unpriced holdings rather than counting them as $0", () => {
    const h = describePortfolio(
      snapshot({ archLamports: 5_000_000_000, tokenCount: 2 }),
      valuation({
        tokenBreakdown: {
          a: { usd: 0, rawAmount: "1", decimals: 0, unpriced: true },
          b: { usd: 3, rawAmount: "1", decimals: 0, unpriced: false },
        },
      }),
    );
    expect(h.secondary).toBe("Partial value");
    expect(h.notes).toContain("Excludes ARCH and 1 token with no price");
  });

  it("falls back to the BTC amount when BTC has no price", () => {
    const h = describePortfolio(snapshot({}), valuation({ btcPriced: false, totalUsd: 0 }));
    expect(h).toMatchObject({ primary: "0.00150000 BTC", secondary: "USD price unavailable" });
  });

  it("marks stale prices", () => {
    const h = describePortfolio(snapshot({}), valuation({ stale: true }));
    expect(h.notes.some((n) => n.startsWith("Prices from"))).toBe(true);
  });

  it("presents a fully priced portfolio as its value, with no performance figure", () => {
    const h = describePortfolio(snapshot({}), valuation({}));
    expect(h).toEqual({ tone: "value", primary: "$90.00", secondary: "Portfolio value", notes: [] });
  });
});
