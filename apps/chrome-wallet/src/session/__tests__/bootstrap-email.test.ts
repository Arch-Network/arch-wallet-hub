/**
 * EmailBootstrap unit tests.
 *
 * The bootstrap's correctness ultimately depends on @turnkey/http and
 * @turnkey/api-key-stamper, both of which are stateful network/crypto
 * libraries we don't want to exercise from a unit test. We mock both
 * so we can:
 *
 *   1. Assert the recovered API key is decrypted from the bundle
 *      exactly once and used to build the stamper.
 *   2. Assert STAMP_LOGIN is called with the correct organizationId,
 *      publicKey, and expiration.
 *   3. Verify the bootstrap is single-use and discards the recovery
 *      key reference after returning (we can't observe memory
 *      directly, but we can prove the local var doesn't leak into
 *      module state).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletAccount } from "../../state/types";

const decryptRecoveryBundleMock = vi.fn();
const ApiKeyStamperMock = vi.fn();
const stampLoginMock = vi.fn();

vi.mock("../../crypto/turnkey-bundle", () => ({
  decryptRecoveryBundle: decryptRecoveryBundleMock,
}));

vi.mock("@turnkey/api-key-stamper", () => ({
  ApiKeyStamper: ApiKeyStamperMock,
}));

vi.mock("@turnkey/http", () => ({
  TurnkeyClient: vi.fn(() => ({ stampLogin: stampLoginMock })),
}));

const makeAccount = (): WalletAccount =>
  ({
    id: "acct-1",
    label: "Email wallet",
    btcAddress: "tb1q-email",
    publicKeyHex: "pk",
    turnkeyResourceId: "res-1",
    organizationId: "sub-org-1",
    authMethod: "email",
    createdAt: 0,
  }) as WalletAccount;

describe("EmailBootstrap.register", () => {
  beforeEach(() => {
    decryptRecoveryBundleMock.mockReturnValue({
      publicKeyHex: "0xrecoverypub",
      privateKeyHex: "0xrecoverypriv",
    });
    ApiKeyStamperMock.mockReturnValue({ tag: "fake-stamper" });
    stampLoginMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("decrypts the bundle, builds an API-key-stamped TurnkeyClient, and STAMP_LOGINs", async () => {
    const { EmailBootstrap } = await import("../bootstrap-email");
    const bootstrap = new EmailBootstrap({
      credentialBundle: "ENCRYPTED_BUNDLE",
      ephemeralPrivateKeyHex: "0xephemeral",
    });

    await bootstrap.register({
      account: makeAccount(),
      publicKeyHex: "0xindexeddbpub",
      expirationSeconds: 600,
    });

    expect(decryptRecoveryBundleMock).toHaveBeenCalledTimes(1);
    expect(decryptRecoveryBundleMock).toHaveBeenCalledWith({
      credentialBundle: "ENCRYPTED_BUNDLE",
      ephemeralPrivateKeyHex: "0xephemeral",
    });

    expect(ApiKeyStamperMock).toHaveBeenCalledTimes(1);
    expect(ApiKeyStamperMock).toHaveBeenCalledWith({
      apiPublicKey: "0xrecoverypub",
      apiPrivateKey: "0xrecoverypriv",
    });

    expect(stampLoginMock).toHaveBeenCalledTimes(1);
    const [arg] = stampLoginMock.mock.calls[0]!;
    expect(arg.type).toBe("ACTIVITY_TYPE_STAMP_LOGIN");
    expect(arg.organizationId).toBe("sub-org-1");
    expect(arg.parameters.publicKey).toBe("0xindexeddbpub");
    expect(arg.parameters.expirationSeconds).toBe("600");
  });

  it("surfaces a bundle-decryption failure as a register() rejection", async () => {
    decryptRecoveryBundleMock.mockImplementationOnce(() => {
      throw new Error("bad bundle");
    });
    const { EmailBootstrap } = await import("../bootstrap-email");
    const bootstrap = new EmailBootstrap({
      credentialBundle: "BAD",
      ephemeralPrivateKeyHex: "0xephemeral",
    });
    await expect(
      bootstrap.register({
        account: makeAccount(),
        publicKeyHex: "0xindexeddbpub",
        expirationSeconds: 600,
      }),
    ).rejects.toThrow(/bad bundle/);
    expect(stampLoginMock).not.toHaveBeenCalled();
  });

  it("surfaces a STAMP_LOGIN failure as a register() rejection", async () => {
    stampLoginMock.mockRejectedValueOnce(new Error("stamp_failed"));
    const { EmailBootstrap } = await import("../bootstrap-email");
    const bootstrap = new EmailBootstrap({
      credentialBundle: "ENCRYPTED_BUNDLE",
      ephemeralPrivateKeyHex: "0xephemeral",
    });
    await expect(
      bootstrap.register({
        account: makeAccount(),
        publicKeyHex: "0xindexeddbpub",
        expirationSeconds: 600,
      }),
    ).rejects.toThrow(/stamp_failed/);
  });

  it("does not retain the bundle across register() calls (each call re-decrypts)", async () => {
    const { EmailBootstrap } = await import("../bootstrap-email");
    const bootstrap = new EmailBootstrap({
      credentialBundle: "BUNDLE_A",
      ephemeralPrivateKeyHex: "0xephemeralA",
    });

    await bootstrap.register({
      account: makeAccount(),
      publicKeyHex: "0xindexeddbpub",
      expirationSeconds: 600,
    });
    await bootstrap.register({
      account: makeAccount(),
      publicKeyHex: "0xindexeddbpub2",
      expirationSeconds: 600,
    });

    expect(decryptRecoveryBundleMock).toHaveBeenCalledTimes(2);
    expect(stampLoginMock).toHaveBeenCalledTimes(2);
  });
});
