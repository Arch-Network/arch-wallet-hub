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

import { PasskeyBootstrap } from "../bootstrap-passkey";

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
});
