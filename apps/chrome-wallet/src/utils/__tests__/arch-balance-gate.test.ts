/**
 * Tests for the SEND_TRANSFER / SEND_TOKEN_TRANSFER pre-flight ARCH
 * balance gate (amount + network fee).
 */

import { describe, it, expect } from "vitest";
import { computeArchTransferGate } from "../transfer-gates";
import { TOKEN_ACCOUNT_DEPOSIT_LAMPORTS } from "../arch-fee";

const FEE = 5_000n;

describe("computeArchTransferGate", () => {
  it("returns loading when balance not yet fetched", () => {
    expect(computeArchTransferGate(null, 100n, FEE).state).toBe("loading");
  });

  it("does not block on indexer error (transient failure)", () => {
    const gate = computeArchTransferGate(
      { kind: "error", reason: "timeout" },
      10_000n,
      FEE,
    );
    expect(gate.state).toBe("ok");
    if (gate.state === "ok") expect(gate.postLamports).toBeNull();
  });

  it("does not block when account not found on chain (fresh wallet)", () => {
    const gate = computeArchTransferGate({ kind: "not_found" }, 10_000n, FEE);
    expect(gate.state).toBe("ok");
    if (gate.state === "ok") expect(gate.postLamports).toBeNull();
  });

  it("predicts post-balance net of amount and fee", () => {
    const gate = computeArchTransferGate({ kind: "found", lamports: 1_000_000n }, 250_000n, FEE);
    expect(gate.state).toBe("ok");
    if (gate.state === "ok") expect(gate.postLamports).toBe(745_000n);
  });

  it("blocks a full-balance ARCH transfer (no room for the fee)", () => {
    const gate = computeArchTransferGate({ kind: "found", lamports: 1_000_000n }, 1_000_000n, FEE);
    expect(gate.state).toBe("blocked");
    if (gate.state === "blocked") {
      expect(gate.requestedLamports).toBe(1_000_000n);
      expect(gate.feeLamports).toBe(FEE);
      expect(gate.availableLamports).toBe(1_000_000n);
    }
  });

  it("allows balance minus fee (account drained to zero)", () => {
    const gate = computeArchTransferGate({ kind: "found", lamports: 1_000_000n }, 1_000_000n - FEE, FEE);
    expect(gate.state).toBe("ok");
    if (gate.state === "ok") expect(gate.postLamports).toBe(0n);
  });

  it("token transfer: blocks when the ARCH balance is below the fee", () => {
    expect(computeArchTransferGate({ kind: "found", lamports: FEE - 1n }, 0n, FEE).state).toBe("blocked");
    const ok = computeArchTransferGate({ kind: "found", lamports: FEE }, 0n, FEE);
    expect(ok.state).toBe("ok");
    if (ok.state === "ok") expect(ok.postLamports).toBe(0n);
  });

  it("does not charge a fee paid by another account", () => {
    expect(computeArchTransferGate({ kind: "found", lamports: 1_000n }, 1_000n, 0n).state).toBe("ok");
  });

  it("blocks when requested amount exceeds available", () => {
    const gate = computeArchTransferGate({ kind: "found", lamports: 1_000n }, 1_001n, FEE);
    expect(gate.state).toBe("blocked");
    if (gate.state === "blocked") {
      expect(gate.requestedLamports).toBe(1_001n);
      expect(gate.availableLamports).toBe(1_000n);
    }
  });

  it("fails closed on a malformed amount (null)", () => {
    expect(computeArchTransferGate({ kind: "found", lamports: 500n }, null, FEE).state).toBe(
      "invalid-amount",
    );
    expect(computeArchTransferGate(null, null, FEE).state).toBe("invalid-amount");
  });

  it("fails closed when the fee couldn't be computed", () => {
    expect(computeArchTransferGate({ kind: "found", lamports: 10n ** 18n }, 1n, null).state).toBe("fee-unknown");
    expect(computeArchTransferGate({ kind: "error", reason: "timeout" }, 1n, null).state).toBe("fee-unknown");
  });

  describe("check_rent: sender side", () => {
    const BAL = 1_000_000n;
    it.each([1n, 255n])("blocks a send that leaves the sender with %s lamports", (left) => {
      const gate = computeArchTransferGate({ kind: "found", lamports: BAL }, BAL - FEE - left, FEE);
      expect(gate.state).toBe("blocked");
      if (gate.state === "blocked") {
        expect(gate.reason).toBe("sender-dust");
        expect(gate.dustLamports).toBe(left);
      }
    });
    it.each([0n, 256n])("allows a send that leaves the sender with %s lamports", (left) => {
      const gate = computeArchTransferGate({ kind: "found", lamports: BAL }, BAL - FEE - left, FEE);
      expect(gate.state).toBe("ok");
      if (gate.state === "ok") expect(gate.postLamports).toBe(left);
    });
  });

  describe("check_rent: recipient side", () => {
    const sender = { kind: "found" as const, lamports: 1_000_000n };
    it("blocks a tiny send to an empty (0-lamport) recipient", () => {
      for (const amount of [1n, 255n]) {
        const gate = computeArchTransferGate(sender, amount, FEE, { recipient: { kind: "found", lamports: 0n } });
        expect(gate.state).toBe("blocked");
        if (gate.state === "blocked") expect(gate.reason).toBe("recipient-dust");
      }
    });
    it("allows 256 to an empty recipient and any amount to a funded one", () => {
      expect(computeArchTransferGate(sender, 256n, FEE, { recipient: { kind: "found", lamports: 0n } }).state).toBe("ok");
      expect(computeArchTransferGate(sender, 1n, FEE, { recipient: { kind: "found", lamports: 256n } }).state).toBe("ok");
    });
    it("only warns when the recipient's balance is unknown", () => {
      for (const recipient of [{ kind: "not_found" as const }, { kind: "error" as const, reason: "timeout" }]) {
        const tiny = computeArchTransferGate(sender, 1n, FEE, { recipient });
        expect(tiny.state).toBe("ok");
        if (tiny.state === "ok") expect(tiny.recipientUnverified).toBe(true);
        const big = computeArchTransferGate(sender, 256n, FEE, { recipient });
        if (big.state === "ok") expect(big.recipientUnverified).toBe(false);
      }
    });
    it("waits for the recipient's balance", () => {
      expect(computeArchTransferGate(sender, 1n, FEE, { recipient: null }).state).toBe("loading");
    });
  });

  describe("token account deposit", () => {
    const need = FEE + TOKEN_ACCOUNT_DEPOSIT_LAMPORTS;
    it("is 586 lamports", () => {
      expect(TOKEN_ACCOUNT_DEPOSIT_LAMPORTS).toBe(586n);
    });
    it("blocks at fee + deposit - 1 and passes at exactly fee + deposit", () => {
      const short = computeArchTransferGate({ kind: "found", lamports: need - 1n }, 0n, FEE, {
        depositLamports: TOKEN_ACCOUNT_DEPOSIT_LAMPORTS,
      });
      expect(short.state).toBe("blocked");
      if (short.state === "blocked") expect(short.reason).toBe("insufficient");
      const exact = computeArchTransferGate({ kind: "found", lamports: need }, 0n, FEE, {
        depositLamports: TOKEN_ACCOUNT_DEPOSIT_LAMPORTS,
      });
      expect(exact.state).toBe("ok");
      if (exact.state === "ok") expect(exact.postLamports).toBe(0n);
    });
    it("needs no deposit when the token account already exists", () => {
      const gate = computeArchTransferGate({ kind: "found", lamports: FEE }, 0n, FEE, { depositLamports: 0n });
      expect(gate.state).toBe("ok");
      if (gate.state === "ok") expect(gate.depositLamports).toBe(0n);
    });
    it("also applies the sender dust rule after the deposit", () => {
      const gate = computeArchTransferGate({ kind: "found", lamports: need + 100n }, 0n, FEE, {
        depositLamports: TOKEN_ACCOUNT_DEPOSIT_LAMPORTS,
      });
      expect(gate.state).toBe("blocked");
      if (gate.state === "blocked") expect(gate.reason).toBe("sender-dust");
    });
  });
});
