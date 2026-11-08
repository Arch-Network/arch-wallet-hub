import { describe, expect, it, vi } from "vitest";
import { fetchWalletOverview } from "../wallet-overview";
import { HubRateLimitError } from "../hub-rate-limit";
import { isIndexerRateLimitError, type IndexerClient } from "../indexer";

let n = 0;
/** Unique addresses per test: the overview cache is module state. */
function params() {
  n += 1;
  return { inputAddress: `tb1pinput${n}`, archAccountAddress: `arch${n}`, btcAddress: `tb1pbtc${n}` };
}

function fakeClient(overrides: Partial<Record<keyof IndexerClient, (...args: any[]) => Promise<unknown>>>) {
  const client = {
    network: "testnet",
    getAccountSummary: vi.fn(async () => ({ address: "arch", lamports_balance: 7 })),
    getBtcAddressSummary: vi.fn(async () => ({ chain_stats: { funded_txo_sum: 9, spent_txo_sum: 0 } })),
    getAccountTransactionsV2: vi.fn(async () => ({ transactions: [] })),
    getAccountTransactions: vi.fn(async () => ({ transactions: [] })),
  };
  for (const [k, fn] of Object.entries(overrides)) (client as any)[k] = vi.fn(fn);
  return client as typeof client & IndexerClient;
}

describe("fetchWalletOverview", () => {
  it("reports failed reads as errors, not as empty balances, and does not cache them", async () => {
    const client = fakeClient({
      getAccountSummary: async () => {
        throw new HubRateLimitError(10_000);
      },
      getBtcAddressSummary: async () => {
        throw new Error("Hub indexer error 503");
      },
    });
    const p = params();

    const first = await fetchWalletOverview(client, p);
    expect(first.arch.account).toBeNull();
    expect(isIndexerRateLimitError(first.arch.accountError)).toBe(true);
    expect(first.btc.summary).toBeNull();
    expect(first.btc.summaryError).toBeInstanceOf(Error);

    await fetchWalletOverview(client, p);
    expect(client.getAccountSummary).toHaveBeenCalledTimes(2);
    expect(client.getBtcAddressSummary).toHaveBeenCalledTimes(2);
  });

  it("caches a fully answered overview", async () => {
    const client = fakeClient({});
    const p = params();

    const first = await fetchWalletOverview(client, p);
    expect(first.arch.accountError).toBeNull();
    expect(first.btc.summaryError).toBeNull();
    await fetchWalletOverview(client, p);
    expect(client.getAccountSummary).toHaveBeenCalledTimes(1);
  });

  it("treats a not-found account as empty, not as an error", async () => {
    const client = fakeClient({
      getAccountSummary: async () => {
        throw new Error("Hub indexer error 404: account not found");
      },
    });

    const overview = await fetchWalletOverview(client, params());
    expect(overview.arch.account).toBeNull();
    expect(overview.arch.accountError).toBeNull();
    expect(client.getAccountTransactionsV2).not.toHaveBeenCalled();
  });

  it("does not fall back to v1 transactions when v2 is rate limited", async () => {
    const client = fakeClient({
      getAccountTransactionsV2: async () => {
        throw new HubRateLimitError(10_000);
      },
    });

    const overview = await fetchWalletOverview(client, params());
    expect(client.getAccountTransactions).not.toHaveBeenCalled();
    expect(isIndexerRateLimitError(overview.arch.recentTransactionsError)).toBe(true);
  });

  it("still falls back to v1 when v2 fails for another reason", async () => {
    const client = fakeClient({
      getAccountTransactionsV2: async () => {
        throw new Error("Hub indexer error 500");
      },
    });

    const overview = await fetchWalletOverview(client, params());
    expect(client.getAccountTransactions).toHaveBeenCalledTimes(1);
    expect(overview.arch.recentTransactionsError).toBeNull();
  });
});
