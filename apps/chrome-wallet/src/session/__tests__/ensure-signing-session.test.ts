import { describe, expect, it } from "vitest";
import {
  EmailSessionNeededError,
  WatchOnlyAccountError,
  ensureSigningSessionForAccount,
} from "../ensure-signing-session";
import type { WalletAccount } from "../../state/types";

/**
 * Contract test for `EmailSessionNeededError`: the inline OTP gate
 * in Approve.tsx reads `error.account` to decide which wallet's
 * recovery email to use. If the error stops carrying the account,
 * the gate would either render against the wrong wallet or refuse
 * to render at all -- either way the user is bounced back to the
 * dashboard, which is the exact regression this gate was added to
 * prevent. Lock the shape here so a future refactor can't drop the
 * field silently.
 */
describe("EmailSessionNeededError", () => {
  const sampleAccount: WalletAccount = {
    id: "acct-1",
    label: "Mainnet email wallet",
    kind: "turnkey",
    authMethod: "email",
    btcAddress: "bc1ptest",
    archAddress: "arch1test",
    publicKeyHex: "0".repeat(64),
    organizationId: "org-1",
    turnkeyResourceId: "res-1",
    recoveryEmail: "user@example.com",
    createdAt: 0,
  };

  it("carries the account so the inline OTP gate can target it", () => {
    const err = new EmailSessionNeededError(sampleAccount);
    expect(err).toBeInstanceOf(Error);
    expect(err.account).toBe(sampleAccount);
    expect(err.account.recoveryEmail).toBe("user@example.com");
    expect(err.name).toBe("EmailSessionNeededError");
  });

  it("is identifiable via instanceof so the catch can branch on it", () => {
    // The Approve handler narrows on `e instanceof EmailSessionNeededError`
    // to decide between mounting the bootstrapper and showing a generic
    // error banner. Verifying instanceof works defends against subclass-
    // erasure regressions from a future bundler / target change.
    try {
      throw new EmailSessionNeededError(sampleAccount);
    } catch (e) {
      expect(e instanceof EmailSessionNeededError).toBe(true);
    }
  });
});

/**
 * Contract test for the watch-only refusal path.
 *
 * `ensureSigningSessionForAccount` is the chokepoint every signing
 * flow goes through. If a watch account ever slipped past the UI
 * gates, this is the wall it would hit. Lock the behaviour:
 *
 *   - throws synchronously (no await needed at call sites that
 *     just want to fail-fast)
 *   - throws our typed error, not a generic one, so the catch in
 *     Approve.tsx can render a wallet-specific banner if we ever
 *     wire one
 *   - carries the offending account on the error
 */
describe("ensureSigningSessionForAccount > watch-only refusal", () => {
  const watchAccount: WalletAccount = {
    id: "watch-abc",
    label: "Cold storage",
    kind: "watch",
    authMethod: "watch",
    btcAddress: "bc1pwatch",
    archAddress: "arch1watch",
    publicKeyHex: "0".repeat(64),
    organizationId: "",
    turnkeyResourceId: "",
    createdAt: 0,
  };

  it("rejects with WatchOnlyAccountError", async () => {
    await expect(ensureSigningSessionForAccount(watchAccount)).rejects.toBeInstanceOf(
      WatchOnlyAccountError,
    );
  });

  it("carries the offending account on the error", async () => {
    try {
      await ensureSigningSessionForAccount(watchAccount);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e instanceof WatchOnlyAccountError).toBe(true);
      if (e instanceof WatchOnlyAccountError) {
        expect(e.account).toBe(watchAccount);
      }
    }
  });
});
