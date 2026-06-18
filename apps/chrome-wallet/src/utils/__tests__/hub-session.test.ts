import { describe, expect, it, vi, beforeEach } from "vitest";
import type { WalletAccount } from "../../state/types";

/**
 * Unit tests for `ensureHubSession` (Phase 2a session minting).
 *
 * The Turnkey signing + server verification contract is covered by
 * `session-token-verify.test.ts`; here we lock the orchestration:
 *   - mints exactly once and caches,
 *   - reuses a cached token without re-minting,
 *   - is a no-op for accounts that can't sign locally,
 *   - is strictly fail-soft (never throws, never persists on failure).
 */

const mocks = vi.hoisted(() => {
  const setSessionToken = vi.fn();
  const createSessionChallenge = vi.fn();
  const mintSessionToken = vi.fn();
  const signArchPayload = vi.fn();
  const getExternalUserId = vi.fn();
  const readHubToken = vi.fn();
  const writeHubToken = vi.fn();
  return {
    client: { setSessionToken, createSessionChallenge, mintSessionToken },
    setSessionToken,
    createSessionChallenge,
    mintSessionToken,
    signArchPayload,
    getExternalUserId,
    readHubToken,
    writeHubToken,
  };
});

vi.mock("../sdk", () => ({
  getClient: vi.fn(async () => mocks.client),
  getExternalUserId: mocks.getExternalUserId,
}));

vi.mock("../../signers/Signer", () => ({
  signerForAccount: vi.fn(() => ({ signArchPayload: mocks.signArchPayload })),
}));

vi.mock("../hub-session-store", () => ({
  readHubToken: mocks.readHubToken,
  writeHubToken: mocks.writeHubToken,
}));

vi.mock("../log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { ensureHubSession } from "../hub-session";

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
  mocks.getExternalUserId.mockResolvedValue("ext-1");
});

describe("ensureHubSession", () => {
  it("mints, persists, and attaches a token when none is cached", async () => {
    mocks.readHubToken.mockResolvedValue(null);
    mocks.createSessionChallenge.mockResolvedValue({
      challengeId: "chal-1",
      message: "msg",
      payloadHex: "a".repeat(64),
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    mocks.signArchPayload.mockResolvedValue({ signature64Hex: "f".repeat(128) });
    mocks.mintSessionToken.mockResolvedValue({
      sessionToken: "whs_v1_token",
      expiresAt: "2026-01-02T00:00:00.000Z",
    });

    await ensureHubSession(passkeyAccount);

    expect(mocks.createSessionChallenge).toHaveBeenCalledWith({
      externalUserId: "ext-1",
      turnkeyResourceId: "res-1",
    });
    expect(mocks.signArchPayload).toHaveBeenCalledWith({
      signingRequestId: "",
      payloadHex: "a".repeat(64),
    });
    expect(mocks.mintSessionToken).toHaveBeenCalledWith({
      challengeId: "chal-1",
      signatureHex: "f".repeat(128),
    });
    expect(mocks.writeHubToken).toHaveBeenCalledWith(
      "ext-1",
      "acct-1",
      "whs_v1_token",
      Date.parse("2026-01-02T00:00:00.000Z"),
    );
    expect(mocks.setSessionToken).toHaveBeenCalledWith("whs_v1_token");
  });

  it("reuses a cached token without minting", async () => {
    mocks.readHubToken.mockResolvedValue("whs_v1_cached");

    await ensureHubSession(passkeyAccount);

    expect(mocks.createSessionChallenge).not.toHaveBeenCalled();
    expect(mocks.mintSessionToken).not.toHaveBeenCalled();
    expect(mocks.setSessionToken).toHaveBeenCalledWith("whs_v1_cached");
  });

  it("is a no-op for external accounts (no local Turnkey key)", async () => {
    const external = { ...passkeyAccount, kind: "external", authMethod: "external" } as WalletAccount;

    await ensureHubSession(external);

    expect(mocks.getExternalUserId).not.toHaveBeenCalled();
    expect(mocks.createSessionChallenge).not.toHaveBeenCalled();
  });

  it("is a no-op when the account has no turnkeyResourceId", async () => {
    await ensureHubSession({ ...passkeyAccount, turnkeyResourceId: "" });
    expect(mocks.createSessionChallenge).not.toHaveBeenCalled();
  });

  it("fails soft when minting throws (no throw, nothing persisted)", async () => {
    mocks.readHubToken.mockResolvedValue(null);
    mocks.createSessionChallenge.mockRejectedValue(new Error("hub offline"));

    await expect(ensureHubSession(passkeyAccount)).resolves.toBeUndefined();
    expect(mocks.writeHubToken).not.toHaveBeenCalled();
    expect(mocks.setSessionToken).not.toHaveBeenCalled();
  });
});
