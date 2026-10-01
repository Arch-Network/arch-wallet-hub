import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { MAINNET_CONFIG } from "@arch/swap-engine";

import { valuatePortfolio } from "../prices";
import { usdPerUnitForMint, usdPerUnitForSymbol } from "../token-usd";

/**
 * Regression tests for wrapped-BTC valuation.
 *
 * aBTC is an APL token, so it used to fall into the "no price feed"
 * bucket and contribute $0 to the portfolio hero — a wallet holding
 * $10 of aBTC and $2 of native sats reported a $2 portfolio. aBTC is
 * wrapped Bitcoin, so it has to be valued at the BTC rate.
 */

const BTC_USD = 63_000;

function hexToBase58(hex: string): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bs58.encode(bytes);
}

function makeFakeChrome() {
  const data: Record<string, unknown> = {};
  return {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: data[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(data, items);
        }),
      },
    },
  };
}

const ABTC_MINT_HEX = MAINNET_CONFIG.tokens.BTC!.mint;
const ABTC_MINT = hexToBase58(ABTC_MINT_HEX);
const UNKNOWN_MINT = hexToBase58("11".repeat(32));

describe("APL token pricing", () => {
  beforeEach(() => {
    (globalThis as any).chrome = makeFakeChrome();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          bitcoin: { usd: BTC_USD, usd_24h_change: -2.79 },
        }),
      })),
    );
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
    vi.unstubAllGlobals();
  });

  describe("usdPerUnitForMint", () => {
    it("prices the mainnet aBTC mint at the BTC rate", () => {
      expect(usdPerUnitForMint(ABTC_MINT, "mainnet", BTC_USD)).toBe(BTC_USD);
      expect(usdPerUnitForMint(ABTC_MINT_HEX, "mainnet", BTC_USD)).toBe(BTC_USD);
    });

    it("returns null for mints outside the registry", () => {
      expect(usdPerUnitForMint(UNKNOWN_MINT, "mainnet", BTC_USD)).toBeNull();
    });

    it("holds dollar-pegged assets at $1", () => {
      expect(usdPerUnitForSymbol("USDT", BTC_USD)).toBe(1);
    });

    it("prices nothing when no BTC price is available", () => {
      // Testnet holds `btcUsd` at null on purpose so test coins never
      // get annotated with real-world dollars — including stablecoins.
      expect(usdPerUnitForMint(ABTC_MINT, "mainnet", null)).toBeNull();
      expect(usdPerUnitForSymbol("USDT", null)).toBeNull();
    });
  });

  describe("valuatePortfolio", () => {
    it("counts an aBTC balance toward the portfolio total", async () => {
      // The reported wallet: 0.00003368 native BTC + 0.00015891 aBTC.
      const v = await valuatePortfolio({
        btcSats: 3368,
        archLamports: 0,
        network: "mainnet",
        tokens: [{ mint: ABTC_MINT, rawAmount: 15891, decimals: 8 }],
      });

      expect(v.btcUsd).toBeCloseTo(2.12, 2);
      expect(v.tokenUsd).toBeCloseTo(10.01, 2);
      expect(v.totalUsd).toBeCloseTo(12.13, 2);
      expect(v.tokenBreakdown[ABTC_MINT]!.unpriced).toBe(false);
    });

    it("leaves unrecognized mints unpriced instead of valuing them at zero", async () => {
      const v = await valuatePortfolio({
        btcSats: 0,
        archLamports: 0,
        network: "mainnet",
        tokens: [{ mint: UNKNOWN_MINT, rawAmount: 5_000_000, decimals: 6 }],
      });

      expect(v.tokenUsd).toBe(0);
      expect(v.tokenBreakdown[UNKNOWN_MINT]).toEqual({
        usd: 0,
        rawAmount: "5000000",
        decimals: 6,
        unpriced: true,
      });
    });

    it("carries the BTC 24h change through wrapped BTC holdings", async () => {
      const v = await valuatePortfolio({
        btcSats: 0,
        archLamports: 0,
        network: "mainnet",
        tokens: [{ mint: ABTC_MINT, rawAmount: 15891, decimals: 8 }],
      });

      expect(v.change24hPct).toBeCloseTo(-2.79, 2);
    });
  });
});
