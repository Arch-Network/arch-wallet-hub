import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletAccount } from "../../state/types";

/**
 * Contract tests for `mintHubSessionWithRecovery` -- the shared
 * Send/Approve wrapper around the Hub session mint.
 *
 * Locks the recovery shape:
 *   - a successful (or skipped) mint never triggers a rebuild,
 *   - a failed mint rebuilds the signing session exactly ONCE
 *     (forceFresh) and re-mints,
 *   - external accounts are never rebuilt (no Turnkey session, and a
 *     retry would re-prompt the source wallet),
 *   - a second failure is reported, not retried again,
 *   - EmailSessionNeededError from the rebuild propagates so the
 *     caller's OTP gate takes over.
 */

const mocks = vi.hoisted(() => ({
  ensureHubSession: vi.fn(),
  ensureSigningSessionForAccount: vi.fn(),
}));

vi.mock("../../utils/hub-session", () => ({
  ensureHubSession: mocks.ensureHubSession,
}));

vi.mock("../ensure-signing-session", () => ({
  ensureSigningSessionForAccount: mocks.ensureSigningSessionForAccount,
}));

import { mintHubSessionWithRecovery } from "../hub-session-recovery";

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
} as WalletAccount;

const externalAccount = {
  ...passkeyAccount,
  id: "acct-ext",
  kind: "external",
  externalProvider: "xverse",
} as unknown as WalletAccount;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureSigningSessionForAccount.mockResolvedValue(undefined);
});

describe("mintHubSessionWithRecovery", () => {
  it("returns 'ok' without rebuilding when the mint succeeds", async () => {
    mocks.ensureHubSession.mockResolvedValue("ok");
    const onRecovery = vi.fn();

    await expect(
      mintHubSessionWithRecovery(passkeyAccount, "mainnet", { onRecovery }),
    ).resolves.toBe("ok");

    expect(mocks.ensureHubSession).toHaveBeenCalledTimes(1);
    expect(mocks.ensureSigningSessionForAccount).not.toHaveBeenCalled();
    expect(onRecovery).not.toHaveBeenCalled();
  });

  it("returns 'skipped' without rebuilding (nothing to retry)", async () => {
    mocks.ensureHubSession.mockResolvedValue("skipped");

    await expect(mintHubSessionWithRecovery(passkeyAccount, "mainnet")).resolves.toBe(
      "skipped",
    );
    expect(mocks.ensureSigningSessionForAccount).not.toHaveBeenCalled();
  });

  it("on failure, rebuilds the signing session once (forceFresh) and re-mints", async () => {
    mocks.ensureHubSession.mockResolvedValueOnce("failed").mockResolvedValueOnce("ok");
    const onRecovery = vi.fn();

    await expect(
      mintHubSessionWithRecovery(passkeyAccount, "mainnet", { onRecovery }),
    ).resolves.toBe("ok");

    expect(onRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.ensureSigningSessionForAccount).toHaveBeenCalledTimes(1);
    expect(mocks.ensureSigningSessionForAccount).toHaveBeenCalledWith(passkeyAccount, {
      forceFresh: true,
    });
    expect(mocks.ensureHubSession).toHaveBeenCalledTimes(2);
  });

  it("reports a second failure instead of retrying again", async () => {
    mocks.ensureHubSession.mockResolvedValue("failed");

    await expect(mintHubSessionWithRecovery(passkeyAccount, "mainnet")).resolves.toBe(
      "failed",
    );

    // Exactly one rebuild and exactly two mint attempts -- no loop.
    expect(mocks.ensureSigningSessionForAccount).toHaveBeenCalledTimes(1);
    expect(mocks.ensureHubSession).toHaveBeenCalledTimes(2);
  });

  it("never rebuilds for external accounts", async () => {
    mocks.ensureHubSession.mockResolvedValue("failed");
    const onRecovery = vi.fn();

    await expect(
      mintHubSessionWithRecovery(externalAccount, "mainnet", { onRecovery }),
    ).resolves.toBe("failed");

    expect(mocks.ensureHubSession).toHaveBeenCalledTimes(1);
    expect(mocks.ensureSigningSessionForAccount).not.toHaveBeenCalled();
    expect(onRecovery).not.toHaveBeenCalled();
  });

  it("propagates a rebuild rejection (e.g. EmailSessionNeededError) to the caller", async () => {
    mocks.ensureHubSession.mockResolvedValue("failed");
    const gateError = new Error("email OTP needed");
    mocks.ensureSigningSessionForAccount.mockRejectedValue(gateError);

    await expect(
      mintHubSessionWithRecovery(passkeyAccount, "mainnet"),
    ).rejects.toBe(gateError);
  });
});
