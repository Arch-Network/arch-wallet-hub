import type { BtcFeeEstimates } from "./indexer";

/**
 * Three-tier BTC fee picker model. The indexer returns an
 * esplora-shaped map keyed by confirmation target ("1", "2", "3", ...
 * "144", "504", "1008"). We collapse that into three buckets the user
 * can reason about: a roughly-one-block target (Fast), a roughly-half-
 * hour target (Normal), and a roughly-one-hour target (Slow).
 *
 * Decisions worth noting:
 *
 *   - Tier rates are forced monotonically non-decreasing (slow <=
 *     normal <= fast). A calm mempool occasionally produces an
 *     estimate map where the 6-block rate is *higher* than the
 *     3-block rate due to interpolation; clamping keeps the picker
 *     from misleading users into paying more for slower confirms.
 *
 *   - When the indexer returns nothing usable, we fall back to
 *     `FALLBACK_FEE_TIERS` rather than throwing. Send.tsx still
 *     surfaces the broader "indexer unavailable" banner; here we
 *     stay functional so the user can at least pick a sane default.
 *
 *   - We don't bake USD or estimated-total math into this module --
 *     the caller has the vsize from the actual PSBT and can compute
 *     a precise fee on demand. Keeping this module sat/vB-only makes
 *     it trivially testable.
 */

export type FeeTierId = "slow" | "normal" | "fast";

export interface FeeTier {
  id: FeeTierId;
  label: string;
  /** Confirmation target this rate was derived from (blocks). */
  blocks: number;
  /** Rough wall-clock ETA in minutes, used for "~10 min" copy. */
  etaMinutes: number;
  satPerVbyte: number;
}

export const DEFAULT_FEE_TIER_ID: FeeTierId = "normal";

const MIN_FEE_RATE_SAT_PER_VBYTE = 1;

/**
 * Conservative fallback when the indexer is unreachable. Picked to
 * approximate a "median mempool" state on mainnet circa 2026 -- the
 * specific values aren't load-bearing because they only show when
 * the indexer is *also* unreachable, in which case the user is going
 * to retry anyway. Keep all three above `MIN_FALLBACK_FEE_RATE` so
 * txs still propagate.
 */
const FALLBACK_FEE_TIERS: FeeTier[] = [
  { id: "slow", label: "Slow", blocks: 6, etaMinutes: 60, satPerVbyte: 5 },
  { id: "normal", label: "Normal", blocks: 3, etaMinutes: 30, satPerVbyte: 10 },
  { id: "fast", label: "Fast", blocks: 1, etaMinutes: 10, satPerVbyte: 20 },
];

/**
 * Build the three-tier model from an esplora-shaped fee map. The
 * input is the raw indexer payload; the caller does not need to
 * pre-normalize it.
 */
export function buildFeeTiers(estimates: BtcFeeEstimates | null | undefined): FeeTier[] {
  if (!estimates || typeof estimates !== "object") {
    return [...FALLBACK_FEE_TIERS];
  }

  const slow = pickRate(estimates, [6, 10, 12, 24], FALLBACK_FEE_TIERS[0]!.satPerVbyte);
  const normal = pickRate(estimates, [3, 4, 6], FALLBACK_FEE_TIERS[1]!.satPerVbyte);
  const fast = pickRate(estimates, [1, 2, 3], FALLBACK_FEE_TIERS[2]!.satPerVbyte);

  // Force monotonicity (slow <= normal <= fast). esplora's interpolated
  // estimates occasionally invert when mempool depth is low.
  const slowR = clamp(slow);
  const normalR = Math.max(clamp(normal), slowR);
  const fastR = Math.max(clamp(fast), normalR);

  return [
    { id: "slow", label: "Slow", blocks: 6, etaMinutes: 60, satPerVbyte: slowR },
    { id: "normal", label: "Normal", blocks: 3, etaMinutes: 30, satPerVbyte: normalR },
    { id: "fast", label: "Fast", blocks: 1, etaMinutes: 10, satPerVbyte: fastR },
  ];
}

/**
 * Look up a rate for the given confirmation target, falling back
 * through nearby targets if the exact one is missing. Returns the
 * fallback rate if nothing usable is present.
 */
function pickRate(
  estimates: BtcFeeEstimates,
  candidateBlocks: number[],
  fallbackRate: number,
): number {
  for (const blocks of candidateBlocks) {
    const raw = (estimates as Record<string, unknown>)[String(blocks)];
    if (typeof raw === "number" && isFinite(raw) && raw > 0) return raw;
  }
  return fallbackRate;
}

function clamp(rate: number): number {
  if (!isFinite(rate) || rate < MIN_FEE_RATE_SAT_PER_VBYTE) {
    return MIN_FEE_RATE_SAT_PER_VBYTE;
  }
  return rate;
}

/**
 * Resolve a tier by id, with a safe fallback so callers don't have
 * to null-check.
 */
export function tierById(tiers: FeeTier[], id: FeeTierId): FeeTier {
  return tiers.find((t) => t.id === id) ?? tiers.find((t) => t.id === DEFAULT_FEE_TIER_ID) ?? tiers[0]!;
}
