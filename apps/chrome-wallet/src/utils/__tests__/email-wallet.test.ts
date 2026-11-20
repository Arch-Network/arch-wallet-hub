import { describe, expect, it } from "vitest";
import { emailWalletResourceId } from "../email-wallet";

describe("emailWalletResourceId", () => {
  const wallets = [
    { id: "resource-a", organizationId: "org-a" },
    { id: "resource-b", organizationId: "org-b" },
  ];

  it("uses the id verify returned", () => {
    expect(
      emailWalletResourceId({ resourceId: "resource-direct", organizationId: "org-b" }, wallets),
    ).toBe("resource-direct");
  });

  it("matches the organization when an older Hub omitted the id", () => {
    expect(emailWalletResourceId({ organizationId: "org-b" }, wallets)).toBe("resource-b");
  });

  it("returns null when neither source has the wallet", () => {
    expect(emailWalletResourceId({ resourceId: "", organizationId: "org-missing" }, wallets)).toBeNull();
  });
});
