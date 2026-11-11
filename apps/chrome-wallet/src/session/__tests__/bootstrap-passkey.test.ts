import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletAccount } from "../../state/types";

const mocks = vi.hoisted(() => {
  const stampLogin = vi.fn();
  const passkeyClient = vi.fn(() => ({ stampLogin }));
  const Turnkey = vi.fn().mockImplementation(() => ({ passkeyClient }));
  return { stampLogin, passkeyClient, Turnkey };
});

vi.mock("@turnkey/sdk-browser", () => ({
  Turnkey: mocks.Turnkey,
}));

import { PasskeyBootstrap, WrongPasskeyError } from "../bootstrap-passkey";

const account: WalletAccount = {
  id: "acct-1",
  label: "Passkey wallet",
  kind: "turnkey",
  authMethod: "passkey",
  btcAddress: "tb1ptest",
  publicKeyHex: "aa".repeat(32),
  organizationId: "org-1",
  turnkeyResourceId: "res-1",
  passkeyCredentialId: "Y3JlZA",
  createdAt: 0,
};

describe("PasskeyBootstrap", () => {
  beforeEach(() => {
    mocks.stampLogin.mockReset();
    mocks.passkeyClient.mockClear();
    mocks.Turnkey.mockClear();
    vi.stubGlobal("chrome", { runtime: { id: "extidextidextidextidextidextido" } });
    vi.stubGlobal("location", { hostname: "extidextidextidextidextidextido" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for a discoverable assertion so 1Password stays on the picker", async () => {
    mocks.stampLogin.mockResolvedValue({});
    await new PasskeyBootstrap().register({
      account,
      publicKeyHex: "pk",
      expirationSeconds: 600,
    });

    expect(mocks.Turnkey).toHaveBeenCalledWith(
      expect.objectContaining({ rpId: "extidextidextidextidextidextido" }),
    );
    expect(mocks.passkeyClient).toHaveBeenCalledWith(
      expect.objectContaining({ userVerification: "required" }),
    );
    expect(mocks.passkeyClient).toHaveBeenCalledWith(
      expect.not.objectContaining({ allowCredentials: expect.anything() }),
    );
  });

  it("says the passkey belongs to another wallet when Turnkey does not find it on this sub-org", async () => {
    // Verbatim from a user report: the other of two saved passkeys answered.
    mocks.stampLogin.mockRejectedValue(
      new Error(
        "Turnkey error 16: credential ID could not be found in organization or its parent organization " +
          "organizationId=9e906f47-388c-4c89-8ee8-066c895032c1 credentialId=3_5Sd25AitUcKe5b6uS5Fjvwa44 " +
          '(Details: [{"@type":"type.googleapis.com/errors.v1.TurnkeyErrorDetail","turnkeyErrorCode":"CREDENTIAL_NOT_FOUND"}])',
      ),
    );

    const attempt = new PasskeyBootstrap().register({
      account,
      publicKeyHex: "pk",
      expirationSeconds: 600,
    });

    await expect(attempt).rejects.toBeInstanceOf(WrongPasskeyError);
    await expect(attempt).rejects.toThrow(
      'That passkey isn\'t registered to "Passkey wallet". Try again and choose a different passkey.',
    );
  });

  it("leaves every other failure as Turnkey reported it", async () => {
    const dismissed = new Error("The operation either timed out or was not allowed.");
    mocks.stampLogin.mockRejectedValue(dismissed);

    await expect(
      new PasskeyBootstrap().register({ account, publicKeyHex: "pk", expirationSeconds: 600 }),
    ).rejects.toBe(dismissed);
  });
});
