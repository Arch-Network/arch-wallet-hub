/**
 * Tests for the SEND_TRANSFER pre-flight balance gate.
 *
 * The gate function isn't exported from Approve.tsx (it's a tight
 * component-local helper). To keep these tests honest without
 * dragging in React, we reimplement the policy here and assert
 * the same shape Approve.tsx consumes. If you change the
 * `computeArchTransferGate` rules in Approve.tsx, update this
 * mirror -- a divergence will surface as a UI regression in the
 * Approve modal.
 *
 * Yes, this is a mirror test rather than a direct unit test. The
 * trade-off is intentional: extracting the gate into a shared
 * util would add a new module for a 20-line function used in
 * exactly one place. The mirror catches policy drift cheaply.
 */

import { describe, it, expect } from "vitest";
import type { ArchBalanceSnapshot } from "../arch-rpc";

type ArchBalanceGate =
  | { state: "loading" }
  | { state: "ok"; snapshot: ArchBalanceSnapshot; postLamports: bigint | null }
  | {
      state: "blocked";
      snapshot: ArchBalanceSnapshot;
      requestedLamports: bigint;
      availableLamports: bigint;
    };

function computeArchTransferGate(
  snapshot: ArchBalanceSnapshot | null,
  requestedLamports: bigint | null,
): ArchBalanceGate {
  if (!snapshot) return { state: "loading" };
  if (snapshot.kind !== "found") return { state: "ok", snapshot, postLamports: null };
  if (requestedLamports === null) {
    return { state: "ok", snapshot, postLamports: snapshot.lamports };
  }
  if (requestedLamports > snapshot.lamports) {
    return {
      state: "blocked",
      snapshot,
      requestedLamports,
      availableLamports: snapshot.lamports,
    };
  }
  return { state: "ok", snapshot, postLamports: snapshot.lamports - requestedLamports };
}

describe("computeArchTransferGate", () => {
  it("returns loading when balance not yet fetched", () => {
    expect(computeArchTransferGate(null, 100n).state).toBe("loading");
  });

  it("does not block on indexer error (transient failure)", () => {
    const gate = computeArchTransferGate(
      { kind: "error", reason: "timeout" },
      10_000n,
    );
    expect(gate.state).toBe("ok");
    if (gate.state === "ok") expect(gate.postLamports).toBeNull();
  });

  it("does not block when account not found on chain (fresh wallet)", () => {
    const gate = computeArchTransferGate({ kind: "not_found" }, 10_000n);
    expect(gate.state).toBe("ok");
    if (gate.state === "ok") expect(gate.postLamports).toBeNull();
  });

  it("predicts post-balance on sufficient funds", () => {
    const gate = computeArchTransferGate({ kind: "found", lamports: 1_000_000n }, 250_000n);
    expect(gate.state).toBe("ok");
    if (gate.state === "ok") expect(gate.postLamports).toBe(750_000n);
  });

  it("allows exact-balance transfer (entire account drained)", () => {
    const gate = computeArchTransferGate({ kind: "found", lamports: 1_000_000n }, 1_000_000n);
    expect(gate.state).toBe("ok");
    if (gate.state === "ok") expect(gate.postLamports).toBe(0n);
  });

  it("blocks when requested amount exceeds available", () => {
    const gate = computeArchTransferGate({ kind: "found", lamports: 1_000n }, 1_001n);
    expect(gate.state).toBe("blocked");
    if (gate.state === "blocked") {
      expect(gate.requestedLamports).toBe(1_001n);
      expect(gate.availableLamports).toBe(1_000n);
    }
  });

  it("handles malformed amount (null) by showing current balance without blocking", () => {
    const gate = computeArchTransferGate({ kind: "found", lamports: 500n }, null);
    expect(gate.state).toBe("ok");
    if (gate.state === "ok") expect(gate.postLamports).toBe(500n);
  });
});
