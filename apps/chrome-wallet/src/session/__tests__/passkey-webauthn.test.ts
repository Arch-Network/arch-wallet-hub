import { afterEach, describe, expect, it, vi } from "vitest";
import {
  effectivePasskeyRpId,
  passkeyAllowCredentials,
  passkeyCreationSelection,
} from "../passkey-webauthn";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("effectivePasskeyRpId", () => {
  it("uses the extension id in a chrome-extension:// document so 1Password matches the origin", () => {
    vi.stubGlobal("chrome", { runtime: { id: "abcdefghijklmnopabcdefghijklmnop" } });
    vi.stubGlobal("location", { hostname: "abcdefghijklmnopabcdefghijklmnop" });
    expect(effectivePasskeyRpId()).toBe("abcdefghijklmnopabcdefghijklmnop");
  });

  it("uses wallet.arch.network on the hosted wallet origin", () => {
    vi.stubGlobal("chrome", { runtime: { id: "abcdefghijklmnopabcdefghijklmnop" } });
    vi.stubGlobal("location", { hostname: "wallet.arch.network" });
    expect(effectivePasskeyRpId()).toBe("wallet.arch.network");
  });

  it("uses localhost on a local https/dev page", () => {
    vi.stubGlobal("location", { hostname: "localhost" });
    expect(effectivePasskeyRpId()).toBe("localhost");
  });
});

describe("passkeyCreationSelection", () => {
  it("does not restrict the picker to platform authenticators", () => {
    const selection = passkeyCreationSelection();
    expect(selection.authenticatorAttachment).toBeUndefined();
    expect(selection.requireResidentKey).toBe(false);
    expect(selection.residentKey).toBe("preferred");
    expect(selection.userVerification).toBe("required");
  });
});

describe("passkeyAllowCredentials", () => {
  it("includes hybrid so password-manager passkeys stay eligible", () => {
    const id = btoa("credential-bytes");
    const descriptors = passkeyAllowCredentials(id);
    expect(descriptors).toHaveLength(1);
    expect(descriptors![0]?.transports).toEqual(
      expect.arrayContaining(["internal", "hybrid"]),
    );
  });

  it("omits the filter when there is no stored credential", () => {
    expect(passkeyAllowCredentials(undefined)).toBeUndefined();
    expect(passkeyAllowCredentials(null)).toBeUndefined();
  });
});
