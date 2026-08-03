import { beforeEach, describe, expect, it, vi } from "vitest";
import { Witness } from "@saturnbtcio/bip322-js";
import type { WalletAccount } from "../../state/types";
import { signArchMessageHashWithExternalWallet } from "../external-arch-message-hash";

const signMessage = vi.fn();

vi.mock("../../wallets/external-wallets", () => ({
  getExternalWalletAdapter: () => ({
    provider: "xverse",
    label: "Xverse",
    signMessage,
  }),
}));

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const externalAccount = {
  id: "ext-1",
  kind: "external",
  label: "Xverse",
  btcAddress: "tb1p0example000000000000000000000000000000000000000000000",
  publicKeyHex: "11".repeat(32),
  archAddress: "22".repeat(32),
  turnkeyResourceId: "",
  organizationId: "",
  authMethod: "passkey",
  externalProvider: "xverse",
  createdAt: 0,
} as WalletAccount;

describe("signArchMessageHashWithExternalWallet", () => {
  beforeEach(() => {
    signMessage.mockReset();
  });

  it("BIP-322-signs the hex string and returns unwrapped Schnorr hex", async () => {
    const messageHashHex = "a1".repeat(32);
    const schnorr = Uint8Array.from({ length: 64 }, (_, i) => i ^ 0x5a);
    signMessage.mockResolvedValue({
      signature: Witness.serialize([schnorr]),
      schemeHint: "bip322",
    });

    await expect(
      signArchMessageHashWithExternalWallet({
        account: externalAccount,
        messageHashHex,
        network: "testnet4",
      }),
    ).resolves.toEqual({ signature64Hex: bytesToHex(schnorr) });

    expect(signMessage).toHaveBeenCalledWith({
      address: externalAccount.btcAddress,
      message: messageHashHex,
      network: "testnet4",
    });
  });

  it("rejects non-external accounts", async () => {
    await expect(
      signArchMessageHashWithExternalWallet({
        account: { ...externalAccount, kind: "turnkey" } as WalletAccount,
        messageHashHex: "aa".repeat(32),
        network: "testnet4",
      }),
    ).rejects.toThrow(/linked external/i);
  });
});
