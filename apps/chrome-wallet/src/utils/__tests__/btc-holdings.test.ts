import { describe, it, expect } from "vitest";
import { fetchBtcHoldings, summarySats } from "../btc-holdings";
import type { BtcAddressSummary } from "../indexer";

const PAYMENT = "2N2uFi5LbDQQwTqAVd5veF6qE9hWww2DVzF";
const ORDINALS = "tb1pgxxyvcmdncdxs06cudd5yvmwwahaesaj6n3eu7st7x4sw9hrchaq9v87jl";

function stats(confirmed: number, pending = 0, protectedSats?: number): BtcAddressSummary {
  return {
    chain_stats: { funded_txo_sum: confirmed, spent_txo_sum: 0 },
    mempool_stats: { funded_txo_sum: pending, spent_txo_sum: 0 },
    ...(protectedSats !== undefined ? { protected_value: protectedSats, spendable_value: confirmed - protectedSats } : {}),
  };
}

describe("summarySats", () => {
  it("reads Esplora-style stats", () => {
    expect(summarySats(stats(1000, 50, 200))).toEqual({ confirmed: 1000, pending: 50, protected: 200 });
  });

  it("reads an output list, skipping spent outputs", () => {
    const summary = {
      outputs: [
        { value: 700, status: { confirmed: true } },
        { value: 300, status: { confirmed: false } },
        { value: 999, status: { confirmed: true }, spent: { spent: true } },
      ],
    } as BtcAddressSummary;
    expect(summarySats(summary)).toEqual({ confirmed: 700, pending: 300, protected: 0 });
  });

  it("reads a flat value", () => {
    expect(summarySats({ value: 42 })).toEqual({ confirmed: 42, pending: 0, protected: 0 });
  });
});

describe("fetchBtcHoldings", () => {
  it("sums payment and ordinals addresses", async () => {
    const indexer = {
      getBtcAddressSummary: async (a: string) => (a === PAYMENT ? stats(120_000, 15_000) : stats(30_000, 0, 10_000)),
    };
    const h = await fetchBtcHoldings(indexer, [PAYMENT, ORDINALS]);
    expect(h).toMatchObject({ confirmed: 150_000, pending: 15_000, protected: 10_000, unavailable: [] });
  });

  it("reports a failed address as unavailable, not zero", async () => {
    const indexer = {
      getBtcAddressSummary: async (a: string) => {
        if (a === PAYMENT) throw new Error("502");
        return stats(30_000);
      },
    };
    const h = await fetchBtcHoldings(indexer, [PAYMENT, ORDINALS]);
    expect(h.unavailable).toEqual([PAYMENT]);
    expect(h.byAddress[PAYMENT]).toBeNull();
    expect(h.confirmed).toBe(30_000);
  });

  it("uses known summaries without refetching, including known failures", async () => {
    const calls: string[] = [];
    const indexer = {
      getBtcAddressSummary: async (a: string) => {
        calls.push(a);
        return stats(5);
      },
    };
    const h = await fetchBtcHoldings(indexer, [PAYMENT, ORDINALS], { [ORDINALS]: null });
    expect(calls).toEqual([PAYMENT]);
    expect(h.unavailable).toEqual([ORDINALS]);
  });
});
