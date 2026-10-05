/**
 * Contract for `window.bitcoinArch` and the wallet-standard
 * registration: only Bitcoin-semantic methods are exposed, and the
 * wallet-standard object follows the standard's account/event shapes.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  const win: any = {
    location: { origin: "https://dapp.example" },
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  win.self = win;
  (globalThis as any).window = win;
});

async function load() {
  vi.resetModules();
  const { bitcoinProvider } = await import("../bitcoin-provider");
  const { buildWalletStandardAdapter } = await import("../wallet-standard");
  return { bitcoinProvider, buildWalletStandardAdapter };
}

const TB_TAPROOT = "tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m";
const BC_TAPROOT = "bc1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnns4f6ks5";

function fakeArch(address: string) {
  return {
    connect: vi.fn(async () => ({ address, publicKey: "0aff", archAddress: "arch" })),
    disconnect: vi.fn(async () => {}),
    sendTransfer: vi.fn(),
    sendTokenTransfer: vi.fn(),
  };
}

describe("bitcoinProvider", () => {
  it("doesn't expose methods that would run with Arch semantics", async () => {
    const { bitcoinProvider } = await load();
    expect("sendTransfer" in bitcoinProvider).toBe(false);
    expect("signMessage" in bitcoinProvider).toBe(false);
    expect(typeof bitcoinProvider.signPsbt).toBe("function");
    expect(bitcoinProvider.name).toBe("Arch Wallet");
  });
});

describe("wallet-standard adapter", () => {
  it("registers as Arch Wallet with no Bitcoin message-signing feature", async () => {
    const { bitcoinProvider, buildWalletStandardAdapter } = await load();
    const wallet = buildWalletStandardAdapter({ arch: fakeArch(TB_TAPROOT), bitcoin: bitcoinProvider });
    expect(wallet.name).toBe("Arch Wallet");
    expect(Object.keys(wallet.features)).not.toContain("bitcoin:signMessage");
    expect(wallet.accounts).toEqual([]);
  });

  it("returns standard accounts on connect and announces the change", async () => {
    const { bitcoinProvider, buildWalletStandardAdapter } = await load();
    const wallet = buildWalletStandardAdapter({ arch: fakeArch(TB_TAPROOT), bitcoin: bitcoinProvider });
    const changes: unknown[] = [];
    const off = (wallet.features["standard:events"] as any).on("change", (p: unknown) => changes.push(p));

    const { accounts } = await (wallet.features["standard:connect"] as any).connect();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].address).toBe(TB_TAPROOT);
    expect(accounts[0].publicKey).toEqual(new Uint8Array([0x0a, 0xff]));
    expect(accounts[0].chains).toEqual(["bitcoin:testnet", "arch:testnet"]);
    expect(wallet.accounts).toBe(accounts);
    expect(changes).toHaveLength(1);

    off();
    await (wallet.features["standard:disconnect"] as any).disconnect();
    expect(wallet.accounts).toEqual([]);
    expect(changes).toHaveLength(1);
  });

  it("labels a mainnet account with mainnet chains", async () => {
    const { bitcoinProvider, buildWalletStandardAdapter } = await load();
    const wallet = buildWalletStandardAdapter({ arch: fakeArch(BC_TAPROOT), bitcoin: bitcoinProvider });
    const { accounts } = await (wallet.features["standard:connect"] as any).connect();
    expect(accounts[0].chains).toEqual(["bitcoin:mainnet", "arch:mainnet"]);
  });

  it("returns a no-op unsubscribe for events it doesn't emit", async () => {
    const { bitcoinProvider, buildWalletStandardAdapter } = await load();
    const wallet = buildWalletStandardAdapter({ arch: fakeArch(TB_TAPROOT), bitcoin: bitcoinProvider });
    const off = (wallet.features["standard:events"] as any).on("accountsChanged", () => {});
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });
});
