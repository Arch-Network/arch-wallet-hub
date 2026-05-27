import { describe, it, expect } from "vitest";
import {
  evaluatePsbtGate,
  PSBT_UNKNOWN_FEE_BLOCK_OUTFLOW_SATS,
  PSBT_HIGH_OUTFLOW_REQUIRE_CONFIRM_SATS,
  type PsbtSummary,
} from "../psbt-summary";

/**
 * The gate function only reads `exactFee` and `netUserSats`; the rest
 * of the summary fields are render-only. Construct minimal stubs so
 * the policy tests stay focused on threshold behaviour.
 */
function makeSummary(opts: { netUserSats: number; exactFee: boolean }): PsbtSummary {
  return {
    network: "mainnet",
    inputs: [],
    outputs: [],
    totalInputSats: 0,
    totalOutputSats: 0,
    feeSats: 0,
    netUserSats: opts.netUserSats,
    exactFee: opts.exactFee,
  };
}

describe("evaluatePsbtGate", () => {
  it("passes through dust-sized outflows with unknown fee (no block)", () => {
    const gate = evaluatePsbtGate(
      makeSummary({ netUserSats: -PSBT_UNKNOWN_FEE_BLOCK_OUTFLOW_SATS, exactFee: false }),
    );
    // The "block" trigger is strictly greater-than the threshold.
    expect(gate.block).toBeNull();
    expect(gate.requireConfirm).toBeNull();
  });

  it("blocks outflows above the unknown-fee threshold", () => {
    const gate = evaluatePsbtGate(
      makeSummary({ netUserSats: -(PSBT_UNKNOWN_FEE_BLOCK_OUTFLOW_SATS + 1), exactFee: false }),
    );
    expect(gate.block).not.toBeNull();
    expect(gate.requireConfirm).toBeNull();
  });

  it("does not block when fee is known, even at high outflow", () => {
    const gate = evaluatePsbtGate(
      makeSummary({ netUserSats: -PSBT_HIGH_OUTFLOW_REQUIRE_CONFIRM_SATS, exactFee: true }),
    );
    expect(gate.block).toBeNull();
    expect(gate.requireConfirm).not.toBeNull();
  });

  it("does not gate inflows (positive net), regardless of fee accounting", () => {
    const inflow = evaluatePsbtGate(makeSummary({ netUserSats: 10_000_000, exactFee: false }));
    expect(inflow.block).toBeNull();
    expect(inflow.requireConfirm).toBeNull();
  });

  it("requires confirm at exactly the high-outflow threshold (inclusive)", () => {
    const gate = evaluatePsbtGate(
      makeSummary({ netUserSats: -PSBT_HIGH_OUTFLOW_REQUIRE_CONFIRM_SATS, exactFee: true }),
    );
    expect(gate.requireConfirm).not.toBeNull();
  });

  it("block takes precedence over require-confirm when both would apply", () => {
    const gate = evaluatePsbtGate(
      // High outflow AND unknown fee -- block should win since it's the
      // stricter signal.
      makeSummary({ netUserSats: -PSBT_HIGH_OUTFLOW_REQUIRE_CONFIRM_SATS, exactFee: false }),
    );
    expect(gate.block).not.toBeNull();
    expect(gate.requireConfirm).toBeNull();
  });
});
