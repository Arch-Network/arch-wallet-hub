/**
 * BTC balance reader with protection awareness.
 *
 * Reads the address-summary endpoint and returns a normalized
 * spendable/protected split:
 *
 *   - When the indexer returned `spendable_value` and `protected_value`
 *     (testnet today; mainnet once Titan-backed sync completes), use
 *     them directly. They're precomputed server-side and account for
 *     edge cases like risky_runes that the per-UTXO sum can't.
 *
 *   - When those fields are absent (mainnet during sync), fall back
 *     to treating the entire confirmed value as spendable. This is
 *     the SAFE FALLBACK: matching pre-protection wallet behavior
 *     exactly, no false negatives that could lock out a user with
 *     no inscriptions or runes.
 *
 * Callers should NOT assume protectedSats > 0 means the user has
 * inscriptions/runes -- absence of protectedSats just means the
 * indexer hasn't told us either way yet.
 */
import type { BtcAddressSummary, IndexerClient } from "./indexer";

export interface BtcBalance {
  /** Total confirmed value reported by the indexer, in sats. */
  totalSats: number;

  /**
   * Sats that are safe to spend on a plain BTC send. Equal to
   * `totalSats` when the indexer hasn't enriched UTXOs yet.
   */
  spendableSats: number;

  /**
   * Sats locked in inscription / rune / risky_rune outputs. Zero
   * when the indexer hasn't enriched UTXOs yet -- DO NOT interpret
   * `protectedSats === 0` as a guarantee that the user holds no
   * inscriptions or runes.
   */
  protectedSats: number;

  /**
   * True when the indexer surfaced explicit protection fields. UI
   * uses this to decide whether to render a "Spendable" subtitle
   * or just the total balance.
   */
  hasProtectionData: boolean;
}

/**
 * Best-effort total from a heterogeneous summary shape. The
 * Titan-backed indexer returns a flat `value` field today; the
 * older Esplora-style schema returned chain_stats / mempool_stats
 * dictionaries. Both are still in the type for backwards-compat
 * with older indexer deployments.
 */
function totalFromSummary(summary: BtcAddressSummary): number {
  if (typeof summary.value === "number") return summary.value;
  const chain = summary.chain_stats;
  if (chain && typeof chain.funded_txo_sum === "number") {
    const funded = chain.funded_txo_sum;
    const spent = typeof chain.spent_txo_sum === "number" ? chain.spent_txo_sum : 0;
    return funded - spent;
  }
  return 0;
}

export async function getBtcBalance(
  indexer: IndexerClient,
  btcAddress: string
): Promise<BtcBalance> {
  const summary = await indexer.getBtcAddressSummary(btcAddress);

  const totalSats = totalFromSummary(summary);
  const protectedRaw = summary.protected_value;
  const spendableRaw = summary.spendable_value;

  // Treat the protection fields as a unit: present together or not
  // at all. A partially-populated response (only one of the two)
  // gets normalized to "no protection data" because we can't trust
  // a partial split.
  const hasProtectionData =
    typeof spendableRaw === "number" && typeof protectedRaw === "number";

  if (hasProtectionData) {
    return {
      totalSats,
      spendableSats: spendableRaw as number,
      protectedSats: protectedRaw as number,
      hasProtectionData: true
    };
  }

  return {
    totalSats,
    spendableSats: totalSats,
    protectedSats: 0,
    hasProtectionData: false
  };
}
