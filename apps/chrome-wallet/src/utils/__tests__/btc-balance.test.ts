/**
 * Tests for getBtcBalance.
 *
 * The helper has to gracefully handle several real-world summary
 * shapes: the Titan-backed shape (testnet today), Esplora-style
 * chain_stats (legacy/older deployments), and the partially-
 * populated case (only `value`, no protection fields -- mainnet
 * during sync).
 */
import { describe, it, expect } from "vitest";
import { getBtcBalance } from "../btc-balance";
import type { IndexerClient, BtcAddressSummary } from "../indexer";

function mockIndexer(summary: BtcAddressSummary): IndexerClient {
  return { getBtcAddressSummary: async () => summary } as unknown as IndexerClient;
}

describe("getBtcBalance — Titan-enriched shape", () => {
  it("uses spendable_value / protected_value verbatim when both present", async () => {
    const r = await getBtcBalance(
      mockIndexer({ value: 2_026_044, spendable_value: 2_022_768, protected_value: 3_276 }),
      "tb1p..."
    );
    expect(r.totalSats).toBe(2_026_044);
    expect(r.spendableSats).toBe(2_022_768);
    expect(r.protectedSats).toBe(3_276);
    expect(r.hasProtectionData).toBe(true);
  });

  it("preserves zero-protected case as enriched (not unsynced)", async () => {
    // Protected fields present but zero -- this is the normal
    // case for a wallet that genuinely has no inscriptions or
    // runes on its address. Must not collapse into the
    // fallback path.
    const r = await getBtcBalance(
      mockIndexer({ value: 100_000, spendable_value: 100_000, protected_value: 0 }),
      "tb1p..."
    );
    expect(r.hasProtectionData).toBe(true);
    expect(r.spendableSats).toBe(100_000);
    expect(r.protectedSats).toBe(0);
  });
});

describe("getBtcBalance — mainnet/unsynced fallback", () => {
  it("treats all balance as spendable when protection fields are absent", async () => {
    const r = await getBtcBalance(
      mockIndexer({ value: 500_000 }),
      "bc1q..."
    );
    expect(r.totalSats).toBe(500_000);
    expect(r.spendableSats).toBe(500_000);
    expect(r.protectedSats).toBe(0);
    expect(r.hasProtectionData).toBe(false);
  });

  it("falls back when ONLY spendable_value is present (partial response)", async () => {
    // Inconsistent partial response: can't trust a half-populated
    // split, so we treat it as no-data and let the user see total.
    const r = await getBtcBalance(
      mockIndexer({ value: 500_000, spendable_value: 400_000 } as any),
      "bc1q..."
    );
    expect(r.hasProtectionData).toBe(false);
    expect(r.spendableSats).toBe(500_000);
    expect(r.protectedSats).toBe(0);
  });

  it("derives total from chain_stats when value is absent (legacy shape)", async () => {
    const r = await getBtcBalance(
      mockIndexer({
        chain_stats: { funded_txo_sum: 1_000_000, spent_txo_sum: 200_000 }
      }),
      "bc1q..."
    );
    expect(r.totalSats).toBe(800_000);
    expect(r.spendableSats).toBe(800_000);
    expect(r.hasProtectionData).toBe(false);
  });

  it("returns zeros for a brand-new empty address", async () => {
    const r = await getBtcBalance(mockIndexer({}), "bc1q...");
    expect(r.totalSats).toBe(0);
    expect(r.spendableSats).toBe(0);
    expect(r.protectedSats).toBe(0);
    expect(r.hasProtectionData).toBe(false);
  });
});
