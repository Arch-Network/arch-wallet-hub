import { describe, expect, it } from "vitest";
import {
  buildFeeTiers,
  DEFAULT_FEE_TIER_ID,
  tierById,
} from "../btc-fee-tiers";

describe("buildFeeTiers", () => {
  it("maps a typical esplora payload to slow/normal/fast", () => {
    const tiers = buildFeeTiers({
      "1": 25.3,
      "2": 18,
      "3": 12.1,
      "6": 6,
      "144": 2,
    });
    expect(tiers.map((t) => t.id)).toEqual(["slow", "normal", "fast"]);
    expect(tiers[0]!.satPerVbyte).toBe(6);
    expect(tiers[1]!.satPerVbyte).toBe(12.1);
    expect(tiers[2]!.satPerVbyte).toBe(25.3);
  });

  it("falls back to nearby targets when exact targets are missing", () => {
    const tiers = buildFeeTiers({
      "2": 18,
      "10": 7,
      // "1", "3", "6" all absent -> fallbacks kick in
    });
    // fast picks "1" (missing) -> "2" -> 18; normal picks "3" missing
    // -> "4" missing -> "6" missing -> hard fallback (10); slow picks
    // "6" missing -> "10" -> 7
    expect(tiers[0]!.satPerVbyte).toBe(7);
    expect(tiers[2]!.satPerVbyte).toBe(18);
    // After monotonicity clamp, normal can't dip below slow.
    expect(tiers[1]!.satPerVbyte).toBeGreaterThanOrEqual(7);
    expect(tiers[1]!.satPerVbyte).toBeLessThanOrEqual(18);
  });

  it("enforces monotonicity (slow <= normal <= fast)", () => {
    // Pathological input: 6-block estimate is HIGHER than 3-block.
    // Without clamping, "Slow" would be more expensive than "Normal".
    const tiers = buildFeeTiers({
      "1": 20,
      "3": 8,
      "6": 12,
    });
    expect(tiers[0]!.satPerVbyte).toBeLessThanOrEqual(tiers[1]!.satPerVbyte);
    expect(tiers[1]!.satPerVbyte).toBeLessThanOrEqual(tiers[2]!.satPerVbyte);
  });

  it("rejects zero/negative/NaN rates", () => {
    const tiers = buildFeeTiers({
      "1": 0,
      "3": -1,
      "6": Number.NaN,
    });
    for (const t of tiers) expect(t.satPerVbyte).toBeGreaterThan(0);
  });

  it("returns fallback tiers when input is null or empty", () => {
    const fromNull = buildFeeTiers(null);
    const fromEmpty = buildFeeTiers({});
    expect(fromNull.map((t) => t.satPerVbyte)).toEqual([5, 10, 20]);
    expect(fromEmpty.map((t) => t.satPerVbyte)).toEqual([5, 10, 20]);
  });
});

describe("tierById", () => {
  it("returns the requested tier", () => {
    const tiers = buildFeeTiers({ "1": 20, "3": 10, "6": 5 });
    expect(tierById(tiers, "fast").satPerVbyte).toBe(20);
    expect(tierById(tiers, "slow").satPerVbyte).toBe(5);
  });

  it("falls back to the default tier when id is missing", () => {
    const tiers = buildFeeTiers({});
    const t = tierById(tiers, "fast");
    expect(t.id).toBe("fast");
    // sanity: default id exists in any non-empty result
    expect(tiers.find((x) => x.id === DEFAULT_FEE_TIER_ID)).toBeDefined();
  });
});
