import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  ensureClient: vi.fn(),
  openPasskeySessionForAccount: vi.fn(),
}));

vi.mock("../SessionManager", () => ({
  sessionManager: { close: mocks.close, ensureClient: mocks.ensureClient },
}));

vi.mock("../../state/wallet-store", () => ({
  walletStore: { openPasskeySessionForAccount: mocks.openPasskeySessionForAccount },
}));

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

/**
 * Contract tests for the `forceFresh` recovery option.
 *
 * `forceFresh` is the programmatic equivalent of the manual lock/unlock
 * users discovered fixes mid-send auth failures: close whatever session
 * looks live (its IndexedDB key may have been rotated by another
 * extension context, or the Turnkey-side API key may have aged out) and
 * bootstrap a brand-new one. The send/approve flows invoke it exactly
 * once after a Hub session-mint failure.
 */
describe("ensureSigningSessionForAccount > forceFresh recovery", () => {
  const passkeyAccount: WalletAccount = {
    id: "acct-1",
    label: "Passkey wallet",
    kind: "turnkey",
    authMethod: "passkey",
    btcAddress: "bc1ptest",
    archAddress: "arch1test",
    publicKeyHex: "0".repeat(64),
    organizationId: "org-1",
    turnkeyResourceId: "res-1",
    createdAt: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("without forceFresh, a live session is reused (no close, no reopen)", async () => {
    mocks.ensureClient.mockResolvedValue({});
    await ensureSigningSessionForAccount(passkeyAccount);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.openPasskeySessionForAccount).not.toHaveBeenCalled();
  });

  it("with forceFresh, closes the current session and bootstraps a new one", async () => {
    await ensureSigningSessionForAccount(passkeyAccount, { forceFresh: true });
    expect(mocks.close).toHaveBeenCalledTimes(1);
    // The live-looking session must NOT be trusted on this path.
    expect(mocks.ensureClient).not.toHaveBeenCalled();
    expect(mocks.openPasskeySessionForAccount).toHaveBeenCalledWith(passkeyAccount);
  });

  it("with forceFresh, an email wallet routes to the OTP gate after closing", async () => {
    const emailAccount = { ...passkeyAccount, authMethod: "email" as const };
    await expect(
      ensureSigningSessionForAccount(emailAccount, { forceFresh: true }),
    ).rejects.toBeInstanceOf(EmailSessionNeededError);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("with forceFresh, external accounts are still a no-op (no Turnkey session involved)", async () => {
    const externalAccount = {
      ...passkeyAccount,
      kind: "external",
      externalProvider: "xverse",
    } as unknown as WalletAccount;
    await ensureSigningSessionForAccount(externalAccount, { forceFresh: true });
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.openPasskeySessionForAccount).not.toHaveBeenCalled();
  });
});
