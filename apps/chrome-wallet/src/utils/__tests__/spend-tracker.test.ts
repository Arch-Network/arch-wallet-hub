import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSpendLogForTests,
  exceedsCap,
  getRecentSpend,
  recordSpend,
} from "../spend-tracker";

interface FakeStorage {
  data: Record<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

function makeFakeChrome(): { storage: { local: FakeStorage } } {
  const data: Record<string, unknown> = {};
  const local: FakeStorage = {
    data,
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
  };
  return { storage: { local } };
}

const ORIGIN_A = "https://app-a.example";
const ORIGIN_B = "https://app-b.example";

describe("spend-tracker", () => {
  beforeEach(async () => {
    (globalThis as any).chrome = makeFakeChrome();
    await __resetSpendLogForTests();
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  describe("recordSpend + getRecentSpend", () => {
    it("sums spend for matching (origin, asset, network) triples", async () => {
      await recordSpend({ origin: ORIGIN_A, asset: "arch", network: "mainnet", amount: 100n });
      await recordSpend({ origin: ORIGIN_A, asset: "arch", network: "mainnet", amount: 250n });
      const total = await getRecentSpend({
        origin: ORIGIN_A,
        asset: "arch",
        network: "mainnet",
      });
      expect(total).toBe(350n);
    });

    it("does NOT mix origins", async () => {
      await recordSpend({ origin: ORIGIN_A, asset: "arch", network: "mainnet", amount: 100n });
      await recordSpend({ origin: ORIGIN_B, asset: "arch", network: "mainnet", amount: 999n });
      const totalA = await getRecentSpend({
        origin: ORIGIN_A,
        asset: "arch",
        network: "mainnet",
      });
      expect(totalA).toBe(100n);
    });

    it("does NOT mix networks", async () => {
      await recordSpend({ origin: ORIGIN_A, asset: "arch", network: "mainnet", amount: 100n });
      await recordSpend({ origin: ORIGIN_A, asset: "arch", network: "testnet4", amount: 999n });
      const mainnet = await getRecentSpend({
        origin: ORIGIN_A,
        asset: "arch",
        network: "mainnet",
      });
      expect(mainnet).toBe(100n);
    });

    it("does NOT mix assets", async () => {
      await recordSpend({ origin: ORIGIN_A, asset: "arch", network: "mainnet", amount: 100n });
      await recordSpend({ origin: ORIGIN_A, asset: "btc", network: "mainnet", amount: 999n });
      const arch = await getRecentSpend({
        origin: ORIGIN_A,
        asset: "arch",
        network: "mainnet",
      });
      expect(arch).toBe(100n);
    });

    it("excludes entries older than the 24h rolling window", async () => {
      const t = 1_700_000_000_000;
      await recordSpend({
        origin: ORIGIN_A,
        asset: "arch",
        network: "mainnet",
        amount: 50n,
        now: t - 25 * 60 * 60 * 1000, // 25h ago
      });
      await recordSpend({
        origin: ORIGIN_A,
        asset: "arch",
        network: "mainnet",
        amount: 7n,
        now: t - 1000, // 1s ago
      });
      const total = await getRecentSpend({
        origin: ORIGIN_A,
        asset: "arch",
        network: "mainnet",
        now: t,
      });
      // The 25h-old entry should be pruned by the prior write or
      // excluded by getRecentSpend. Either way the total is 7.
      expect(total).toBe(7n);
    });

    it("handles amounts that overflow Number.MAX_SAFE_INTEGER", async () => {
      const big = "9007199254740993000"; // > 2^53
      await recordSpend({
        origin: ORIGIN_A,
        asset: "arch",
        network: "mainnet",
        amount: big,
      });
      const total = await getRecentSpend({
        origin: ORIGIN_A,
        asset: "arch",
        network: "mainnet",
      });
      expect(total).toBe(BigInt(big));
    });

    it("returns 0n when chrome.storage is unavailable", async () => {
      delete (globalThis as any).chrome;
      const total = await getRecentSpend({
        origin: ORIGIN_A,
        asset: "arch",
        network: "mainnet",
      });
      expect(total).toBe(0n);
    });

    it("silently no-ops when origin is empty", async () => {
      await recordSpend({ origin: "", asset: "arch", network: "mainnet", amount: 1n });
      const total = await getRecentSpend({
        origin: "",
        asset: "arch",
        network: "mainnet",
      });
      expect(total).toBe(0n);
    });
  });

  describe("exceedsCap", () => {
    it("returns false when cap is undefined (no enforcement)", () => {
      expect(exceedsCap({ pending: 999n, recent: 999n, cap: undefined })).toBe(false);
    });

    it("returns true when (recent + pending) > cap", () => {
      expect(exceedsCap({ pending: 60n, recent: 50n, cap: 100n })).toBe(true);
    });

    it("returns false when (recent + pending) == cap", () => {
      // Strict greater-than: hitting the cap exactly is still allowed.
      // Users who want strict-less-than can set cap-1.
      expect(exceedsCap({ pending: 50n, recent: 50n, cap: 100n })).toBe(false);
    });

    it("returns false when (recent + pending) < cap", () => {
      expect(exceedsCap({ pending: 20n, recent: 50n, cap: 100n })).toBe(false);
    });

    it("honors cap=0n as a kill switch (blocks any pending spend)", () => {
      expect(exceedsCap({ pending: 1n, recent: 0n, cap: 0n })).toBe(true);
    });
  });
});
