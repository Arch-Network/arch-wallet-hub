import { describe, it, expect } from "vitest";
import { resolveAccountAddresses } from "../../../state/account-addresses";
import type { AccountAddress, WalletAccount } from "../../../state/types";
import { receiveDestinations } from "../receive-destinations";

const TB_TAPROOT = "tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m";
const BC_TAPROOT = "bc1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnns4f6ks5";
const TB_NESTED_SEGWIT = "2NBFNJTktNa7GZusGbDbGKRZTxdK9VVez3n";
const ARCH = "9CEiuSgdHtub59syFf4Usf5eEJaEN5eQqEjJNeCatrJs";

function account(overrides: Partial<WalletAccount>): WalletAccount {
  return {
    id: "acct",
    label: "Test",
    btcAddress: TB_TAPROOT,
    publicKeyHex: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    kind: "turnkey",
    turnkeyResourceId: "r",
    organizationId: "o",
    authMethod: "passkey",
    createdAt: 0,
    ...overrides,
  } as WalletAccount;
}

function record(overrides: Partial<AccountAddress>): AccountAddress {
  return {
    address: TB_TAPROOT,
    purposes: ["ordinals"],
    network: "testnet4",
    addressType: "p2tr",
    chainVerified: true,
    ...overrides,
  };
}

const external = { kind: "external", authMethod: "external", externalProvider: "xverse" } as const;

function destinationsFor(acct: WalletAccount, network: "testnet4" | "mainnet" = "testnet4") {
  return receiveDestinations(resolveAccountAddresses(acct, network), ARCH, network, "Xverse");
}

describe("receiveDestinations", () => {
  it("shows one Bitcoin destination for a shared address and says it takes Ordinals and Runes too", () => {
    const [btc, arch, ...rest] = destinationsFor(account({}));
    expect(rest).toEqual([]);
    expect(btc).toMatchObject({ id: "btc", address: TB_TAPROOT, accepts: "BTC, Ordinals, and Runes" });
    expect(btc.note).toMatch(/one address/i);
    expect(arch).toMatchObject({ id: "arch", address: ARCH, network: "Arch Testnet" });
  });

  it("re-encodes a native account's address for the selected network", () => {
    const [btc] = destinationsFor(account({}), "mainnet");
    expect(btc).toMatchObject({ address: BC_TAPROOT, network: "Bitcoin Mainnet" });
  });

  it("sends Xverse BTC to the payment address and Ordinals to the ordinals address", () => {
    const xverse = account({
      ...external,
      addresses: [
        record({ address: TB_NESTED_SEGWIT, purposes: ["payment"], addressType: "p2sh" }),
        record({ address: TB_TAPROOT, purposes: ["ordinals"] }),
      ],
    });
    const [btc, ordinals, arch] = destinationsFor(xverse);
    expect(btc).toMatchObject({ id: "btc", address: TB_NESTED_SEGWIT, accepts: "BTC" });
    expect(btc.note).toMatch(/Spend BTC received here in Xverse/);
    expect(ordinals).toMatchObject({ id: "ordinals", address: TB_TAPROOT, accepts: "Ordinals and Runes" });
    expect(arch.id).toBe("arch");
  });

  it("never offers the ordinals address for BTC when the payment address isn't linked", () => {
    const legacy = account({ ...external, addresses: undefined });
    const [btc, ordinals] = destinationsFor(legacy);
    expect(btc).toMatchObject({ id: "btc", address: null });
    expect(ordinals).toMatchObject({ id: "ordinals", address: TB_TAPROOT });
  });

  it("has no Bitcoin address for a linked account on a network it was never linked on", () => {
    const xverse = account({ ...external, addresses: [record({ purposes: ["payment", "ordinals"] })] });
    const destinations = destinationsFor(xverse, "mainnet");
    expect(destinations.map((d) => d.id)).toEqual(["btc", "arch"]);
    expect(destinations[0].address).toBeNull();
  });
});
