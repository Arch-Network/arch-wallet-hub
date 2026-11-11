import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  getActiveAccount: vi.fn(),
  openPasskeySession: vi.fn(),
}));

vi.mock("../../state/wallet-store", () => ({ walletStore: store }));
vi.mock("../passkey-hosted", () => ({
  hostedPasskeyClient: vi.fn(),
  PASSKEY_NOT_LISTED_LABEL: "My passkey isn't listed",
  usesHostedPasskeyPage: () => true,
}));

import { WrongPasskeyError } from "../bootstrap-passkey";
import { getPasskeyProblem, setPasskeyProblem } from "../passkey-wait";
import { openSigningSessionAfterUnlock } from "../unlock-signing-session";

describe("openSigningSessionAfterUnlock", () => {
  beforeEach(() => {
    store.getActiveAccount.mockReset().mockResolvedValue({ authMethod: "passkey" });
    store.openPasskeySession.mockReset().mockResolvedValue(undefined);
    setPasskeyProblem(null);
  });

  it("opens a session for a passkey wallet and reports nothing", async () => {
    await openSigningSessionAfterUnlock();
    expect(store.openPasskeySession).toHaveBeenCalledTimes(1);
    expect(getPasskeyProblem()).toBeNull();
  });

  it("does not prompt for an email wallet", async () => {
    store.getActiveAccount.mockResolvedValue({ authMethod: "email" });
    await openSigningSessionAfterUnlock();
    expect(store.openPasskeySession).not.toHaveBeenCalled();
  });

  it("publishes a wrong passkey instead of dropping it", async () => {
    store.openPasskeySession.mockRejectedValue(new WrongPasskeyError("normal"));
    await expect(openSigningSessionAfterUnlock()).resolves.toBeUndefined();
    expect(getPasskeyProblem()?.message).toContain(`isn't registered to "normal"`);
  });

  it("retry runs the ceremony again and clears the problem once it succeeds", async () => {
    store.openPasskeySession.mockRejectedValueOnce(new WrongPasskeyError("normal"));
    await openSigningSessionAfterUnlock();

    getPasskeyProblem()!.retry();
    await vi.waitFor(() => expect(store.openPasskeySession).toHaveBeenCalledTimes(2));
    expect(getPasskeyProblem()).toBeNull();
  });

  it("still drops a dismissed prompt", async () => {
    store.openPasskeySession.mockRejectedValue(new Error("Passkey confirmation was cancelled."));
    await expect(openSigningSessionAfterUnlock()).resolves.toBeUndefined();
    expect(getPasskeyProblem()).toBeNull();
  });
});
