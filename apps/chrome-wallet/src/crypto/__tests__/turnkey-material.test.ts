import { describe, expect, it, vi } from "vitest";
import type { WalletAccount } from "../../state/types";
import {
  bitcoinTaprootAccount,
  importHostAccount,
  readImportedWallet,
  readResultString,
  walletIdForAddress,
} from "../turnkey-material";
import { finishSeedImport, prepareSeedImport, revealAccountKey, revealSeedPhrase } from "../turnkey-key-ops";
import { KeyFormat } from "@turnkey/iframe-stamper";

function account(partial: Partial<WalletAccount> & Pick<WalletAccount, "id" | "kind">): WalletAccount {
  return {
    label: partial.id,
    btcAddress: "tb1p",
    publicKeyHex: "ab",
    turnkeyResourceId: "res",
    organizationId: "org",
    authMethod: "passkey",
    createdAt: 0,
    ...partial,
  };
}

describe("bitcoinTaprootAccount", () => {
  it("uses the BIP86 account the Hub creates", () => {
    expect(bitcoinTaprootAccount("mainnet")).toEqual({
      path: "m/86'/0'/0'/0/0",
      addressFormat: "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR",
    });
    expect(bitcoinTaprootAccount("testnet4").path).toBe("m/86'/1'/0'/0/0");
  });
});

describe("walletIdForAddress", () => {
  it("returns the wallet that holds the address", () => {
    expect(
      walletIdForAddress(
        [
          { walletId: "w1", accounts: [{ address: "tb1p-a" }] },
          { walletId: "w2", accounts: [{ address: "tb1p-b" }] },
        ],
        "tb1p-b",
      ),
    ).toBe("w2");
  });

  it("returns null when the address is not a wallet account", () => {
    expect(walletIdForAddress([{ walletId: "w1", accounts: [] }], "tb1p-missing")).toBeNull();
  });
});

describe("importHostAccount", () => {
  const passkey = account({ id: "pass", kind: "turnkey" });
  const external = account({ id: "ext", kind: "external", authMethod: "external" });

  it("prefers the active Turnkey wallet", () => {
    expect(importHostAccount([external, passkey], "pass")?.id).toBe("pass");
  });

  it("falls back to a Turnkey wallet when the active one cannot hold a seed", () => {
    expect(importHostAccount([external, passkey], "ext")?.id).toBe("pass");
  });

  it("returns null when the device has no Turnkey wallet", () => {
    expect(importHostAccount([external], "ext")).toBeNull();
  });
});

describe("activity result readers", () => {
  it("reads a bundle and an imported address", () => {
    const result = {
      exportWalletResult: { exportBundle: "bundle" },
      importWalletResult: { walletId: "w", addresses: ["tb1p-new"] },
    };
    expect(readResultString(result, "exportWalletResult", "exportBundle")).toBe("bundle");
    expect(readImportedWallet(result)).toEqual({ walletId: "w", address: "tb1p-new" });
  });

  it("fails closed when the result is missing", () => {
    expect(() => readResultString({}, "exportWalletResult", "exportBundle")).toThrow(
      /unexpected result/,
    );
    expect(() => readImportedWallet({ importWalletResult: { walletId: "w" } })).toThrow(
      /did not return an address/,
    );
  });
});

function completed(result: Record<string, unknown>) {
  return { activity: { id: "act-1", status: "ACTIVITY_STATUS_COMPLETED", result } };
}

describe("Turnkey key operations", () => {
  it("exports the seed for the wallet that owns the address", async () => {
    const exportWallet = vi.fn(async () =>
      completed({ exportWalletResult: { exportBundle: "seed-bundle" } }),
    );
    const client = {
      getWallets: async () => ({ wallets: [{ walletId: "w1" }, { walletId: "w2" }] }),
      getWalletAccounts: async ({ walletId }: { walletId: string }) => ({
        accounts: [{ address: walletId === "w2" ? "tb1p-mine" : "tb1p-other" }],
      }),
      exportWallet,
      getActivity: vi.fn(),
    };
    const frame = {
      init: async () => "target-key",
      injectWalletExportBundle: vi.fn(async () => true),
      injectKeyExportBundle: vi.fn(),
    };

    await revealSeedPhrase(client as never, frame, {
      organizationId: "org",
      address: "tb1p-mine",
    });

    expect(exportWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org",
        parameters: expect.objectContaining({ walletId: "w2", targetPublicKey: "target-key" }),
      }),
    );
    expect(frame.injectWalletExportBundle).toHaveBeenCalledWith("seed-bundle", "org");
    expect(client.getActivity).not.toHaveBeenCalled();
  });

  it("exports the account private key as WIF for the current network", async () => {
    const client = {
      exportWalletAccount: vi.fn(async () =>
        completed({ exportWalletAccountResult: { exportBundle: "key-bundle" } }),
      ),
    };
    const frame = {
      init: async () => "target-key",
      injectWalletExportBundle: vi.fn(),
      injectKeyExportBundle: vi.fn(async () => true),
    };

    await revealAccountKey(client as never, frame, {
      organizationId: "org",
      address: "tb1p-mine",
      network: "testnet4",
    });

    expect(frame.injectKeyExportBundle).toHaveBeenCalledWith(
      "key-bundle",
      "org",
      KeyFormat.BitcoinTestNetWIF,
      "tb1p-mine",
    );
  });

  it("waits out a pending export before injecting", async () => {
    const client = {
      getWallets: async () => ({ wallets: [{ walletId: "w1" }] }),
      getWalletAccounts: async () => ({ accounts: [{ address: "tb1p-mine" }] }),
      exportWallet: async () => ({
        activity: { id: "act-9", status: "ACTIVITY_STATUS_PENDING", result: null },
      }),
      getActivity: vi.fn(async () =>
        completed({ exportWalletResult: { exportBundle: "later" } }),
      ),
    };
    const frame = {
      init: async () => "target-key",
      injectWalletExportBundle: vi.fn(async () => true),
      injectKeyExportBundle: vi.fn(),
    };

    await revealSeedPhrase(client as never, frame, {
      organizationId: "org",
      address: "tb1p-mine",
    });

    expect(client.getActivity).toHaveBeenCalledWith({ organizationId: "org", activityId: "act-9" });
    expect(frame.injectWalletExportBundle).toHaveBeenCalledWith("later", "org");
  });

  it("accepts the import page's empty ready answer (it holds no key)", async () => {
    const client = {
      getWhoami: async () => ({ userId: "user-1" }),
      initImportWallet: async () =>
        completed({ initImportWalletResult: { importBundle: "init-bundle" } }),
    };
    const frame = {
      init: async () => "",
      applySettings: vi.fn(async () => true),
      injectImportBundle: vi.fn(async () => true),
      extractWalletEncryptedBundle: async () => "encrypted-seed",
    };

    const userId = await prepareSeedImport(client as never, frame, { organizationId: "org" });
    expect(userId).toBe("user-1");
    expect(frame.injectImportBundle).toHaveBeenCalledWith("init-bundle", "org", "user-1");
  });

  it("refuses to export when the page sends no key to encrypt to", async () => {
    const client = { exportWallet: vi.fn(), getWallets: vi.fn(), getActivity: vi.fn() };
    const frame = {
      init: async () => "",
      injectWalletExportBundle: vi.fn(),
      injectKeyExportBundle: vi.fn(),
    };

    await expect(
      revealSeedPhrase(client as never, frame, { organizationId: "org", address: "tb1p-mine" }),
    ).rejects.toThrow("didn't send its key");
    expect(client.exportWallet).not.toHaveBeenCalled();
  });

  it("prepares a seed import and finishes it at the BIP86 path", async () => {
    const importWallet = vi.fn(async () =>
      completed({ importWalletResult: { walletId: "imported", addresses: ["tb1p-new"] } }),
    );
    const client = {
      getWhoami: async () => ({ userId: "user-1" }),
      initImportWallet: vi.fn(async () =>
        completed({ initImportWalletResult: { importBundle: "init-bundle" } }),
      ),
      importWallet,
      getWalletAccounts: async () => ({
        accounts: [{ address: "tb1p-new", publicKey: "02" + "aa".repeat(32) }],
      }),
    };
    const frame = {
      init: async () => "iframe-key",
      applySettings: vi.fn(async () => true),
      injectImportBundle: vi.fn(async () => true),
      extractWalletEncryptedBundle: async () => "encrypted-seed",
    };

    const userId = await prepareSeedImport(client as never, frame, { organizationId: "org" });
    expect(userId).toBe("user-1");
    expect(frame.injectImportBundle).toHaveBeenCalledWith("init-bundle", "org", "user-1");

    const imported = await finishSeedImport(client as never, frame, {
      organizationId: "org",
      userId,
      walletName: "arch-import",
      network: "mainnet",
    });

    expect(imported).toEqual({
      walletId: "imported",
      address: "tb1p-new",
      publicKeyHex: "02" + "aa".repeat(32),
    });
    expect(importWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: expect.objectContaining({
          userId: "user-1",
          encryptedBundle: "encrypted-seed",
          accounts: [
            expect.objectContaining({
              path: "m/86'/0'/0'/0/0",
              addressFormat: "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR",
            }),
          ],
        }),
      }),
    );
  });
});
