import { describe, expect, it } from "vitest";
import { pickHubResource } from "../hub-resource-match";

const hub = {
  id: "hub-resource-1",
  organizationId: "org-1",
  walletId: "turnkey-wallet-1",
  defaultPublicKeyHex: "aa",
};

describe("pickHubResource", () => {
  it("leaves an account that already stores the Hub resource id", () => {
    expect(
      pickHubResource(
        { turnkeyResourceId: "hub-resource-1", organizationId: "org-1", publicKeyHex: "aa" },
        [hub],
      ),
    ).toBeNull();
  });

  it("maps a recovered account that stored Turnkey's wallet id", () => {
    expect(
      pickHubResource(
        { turnkeyResourceId: "turnkey-wallet-1", organizationId: "org-1", publicKeyHex: "aa" },
        [hub],
      ),
    ).toBe(hub);
  });

  it("matches the public key when the stored id is neither id", () => {
    expect(
      pickHubResource(
        { turnkeyResourceId: "recovered-xyz", organizationId: "other", publicKeyHex: "AA" },
        [hub],
      )?.id,
    ).toBe("hub-resource-1");
  });

  it("does not guess when several wallets share the organization", () => {
    expect(
      pickHubResource(
        { turnkeyResourceId: "nope", organizationId: "org-1", publicKeyHex: "" },
        [hub, { ...hub, id: "hub-resource-2", walletId: "turnkey-wallet-2" }],
      ),
    ).toBeNull();
  });
});
