import { describe, expect, it, vi, beforeEach } from "vitest";
import type { WalletAccount } from "../../state/types";

/**
 * Unit tests for `ensureHubSession` session minting.
 *
 * Locks the orchestration for both wallet kinds:
 *   - Turnkey: schnorr-signs the challenge payload, mints, caches.
 *   - External (Xverse/UniSat): BIP-322-signs the challenge message via
 *     the source-wallet adapter, mints via the external endpoints.
 *   - reuses a cached token without re-minting,
 *   - is a no-op for watch-only accounts,
 *   - is strictly fail-soft (never throws, never persists on failure).
 */

const mocks = vi.hoisted(() => {
  const setSessionToken = vi.fn();
  const createSessionChallenge = vi.fn();
  const mintSessionToken = vi.fn();
  const createExternalSessionChallenge = vi.fn();
  const mintExternalSessionToken = vi.fn();
  const signArchPayload = vi.fn();
  const signMessage = vi.fn();
  const getExternalUserId = vi.fn();
  const readHubToken = vi.fn();
  const writeHubToken = vi.fn();
  return {
    client: {
      setSessionToken,
      createSessionChallenge,
      mintSessionToken,
      createExternalSessionChallenge,
      mintExternalSessionToken,
    },
    setSessionToken,
    createSessionChallenge,
    mintSessionToken,
    createExternalSessionChallenge,
    mintExternalSessionToken,
    signArchPayload,
    signMessage,
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

vi.mock("../../wallets/external-wallets", () => ({
  getExternalWalletAdapter: vi.fn(() => ({ signMessage: mocks.signMessage })),
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

const externalAccount: WalletAccount = {
  ...passkeyAccount,
  id: "acct-ext",
  kind: "external",
  authMethod: "external" as WalletAccount["authMethod"],
  externalProvider: "xverse",
  btcAddress: "bc1pext",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getExternalUserId.mockResolvedValue("ext-1");
});

describe("ensureHubSession (Turnkey)", () => {
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

    await ensureHubSession(passkeyAccount, "mainnet");

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

    await ensureHubSession(passkeyAccount, "mainnet");

    expect(mocks.createSessionChallenge).not.toHaveBeenCalled();
    expect(mocks.mintSessionToken).not.toHaveBeenCalled();
    expect(mocks.setSessionToken).toHaveBeenCalledWith("whs_v1_cached");
  });

  it("is a no-op when the account has no turnkeyResourceId", async () => {
    mocks.readHubToken.mockResolvedValue(null);
    await ensureHubSession({ ...passkeyAccount, turnkeyResourceId: "" }, "mainnet");
    expect(mocks.createSessionChallenge).not.toHaveBeenCalled();
  });

  it("fails soft when minting throws (no throw, nothing persisted)", async () => {
    mocks.readHubToken.mockResolvedValue(null);
    mocks.createSessionChallenge.mockRejectedValue(new Error("hub offline"));

    await expect(ensureHubSession(passkeyAccount, "mainnet")).resolves.toBeUndefined();
    expect(mocks.writeHubToken).not.toHaveBeenCalled();
    expect(mocks.setSessionToken).not.toHaveBeenCalled();
  });
});

describe("ensureHubSession (external / BIP-322)", () => {
  it("mints via the external endpoints using a BIP-322 signature", async () => {
    mocks.readHubToken.mockResolvedValue(null);
    mocks.createExternalSessionChallenge.mockResolvedValue({
      challengeId: "ext-chal",
      message: "please sign this",
      expiresAt: "2026-01-02T00:00:00.000Z",
    });
    mocks.signMessage.mockResolvedValue({ signature: "base64sig", schemeHint: "bip322" });
    mocks.mintExternalSessionToken.mockResolvedValue({
      sessionToken: "whs_v1_ext",
      expiresAt: "2026-01-02T00:00:00.000Z",
    });

    await ensureHubSession(externalAccount, "mainnet");

    expect(mocks.createExternalSessionChallenge).toHaveBeenCalledWith({
      externalUserId: "ext-1",
      walletProvider: "xverse",
      address: "bc1pext",
    });
    expect(mocks.signMessage).toHaveBeenCalledWith({
      address: "bc1pext",
      message: "please sign this",
      network: "mainnet",
    });
    expect(mocks.mintExternalSessionToken).toHaveBeenCalledWith({
      challengeId: "ext-chal",
      signature: "base64sig",
    });
    // The Turnkey path must not be touched for an external wallet.
    expect(mocks.createSessionChallenge).not.toHaveBeenCalled();
    expect(mocks.setSessionToken).toHaveBeenCalledWith("whs_v1_ext");
  });
});

describe("ensureHubSession (watch-only)", () => {
  it("is a no-op for watch-only accounts", async () => {
    const watch = { ...passkeyAccount, kind: "watch" } as WalletAccount;
    await ensureHubSession(watch, "mainnet");
    expect(mocks.getExternalUserId).not.toHaveBeenCalled();
    expect(mocks.createSessionChallenge).not.toHaveBeenCalled();
    expect(mocks.createExternalSessionChallenge).not.toHaveBeenCalled();
  });
});
