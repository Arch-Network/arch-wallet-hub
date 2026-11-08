import { describe, it, expect } from "vitest";
import type { AccountAddress, WalletAccount } from "../../state/types";
import type { BridgeConnectResult } from "../bridge/protocol";
import { BridgeError } from "../bridge/errors";
import { connectionAddresses, relinkedAddresses } from "../relink";

const TB_TAPROOT = "tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m";
const OTHER_TAPROOT = "tb1pgxxy0q0ld6jw0yjt3lz4ksdhr4nrtw3l2z4r2mw2v3f8dl33ugqq387jl";
const TB_NESTED_SEGWIT = "2NBFNJTktNa7GZusGbDbGKRZTxdK9VVez3n";
const BC_TAPROOT = "bc1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnns4f6ks5";

const legacyXverse = {
  id: "x",
  label: "Xverse",
  btcAddress: TB_TAPROOT,
  publicKeyHex: "ab",
  kind: "external",
  authMethod: "external",
  externalProvider: "xverse",
  linkedWalletId: "lw-1",
  turnkeyResourceId: "",
  organizationId: "",
  createdAt: 0,
} as WalletAccount;

function connected(identity: string, chainVerified = true): BridgeConnectResult {
  return {
    provider: "xverse",
    address: identity,
    publicKeyHex: "ab",
    chainVerified,
    addresses: [
      { address: TB_NESTED_SEGWIT, publicKeyHex: "02cd", purposes: ["payment"], addressType: "p2sh" },
      { address: identity, publicKeyHex: "ab", purposes: ["ordinals"], addressType: "p2tr" },
    ],
  };
}

describe("connectionAddresses", () => {
  it("records every returned address on the requested network with the chain verification result", () => {
    expect(connectionAddresses(connected(TB_TAPROOT, false), "testnet4")).toEqual([
      { address: TB_NESTED_SEGWIT, publicKeyHex: "02cd", purposes: ["payment"], network: "testnet4", addressType: "p2sh", chainVerified: false },
      { address: TB_TAPROOT, publicKeyHex: "ab", purposes: ["ordinals"], network: "testnet4", addressType: "p2tr", chainVerified: false },
    ]);
  });
});

describe("relinkedAddresses", () => {
  it("adds the payment address when the wallet reports the account's own identity address", () => {
    const addresses = relinkedAddresses(legacyXverse, connected(TB_TAPROOT), "testnet4");
    expect(addresses.map((a) => [a.address, a.purposes])).toEqual([
      [TB_NESTED_SEGWIT, ["payment"]],
      [TB_TAPROOT, ["ordinals"]],
    ]);
  });

  it("refuses a different account instead of merging its addresses", () => {
    expect(() => relinkedAddresses(legacyXverse, connected(OTHER_TAPROOT), "testnet4")).toThrow(BridgeError);
    try {
      relinkedAddresses(legacyXverse, connected(OTHER_TAPROOT), "testnet4");
    } catch (e) {
      expect((e as BridgeError).code).toBe("ACCOUNT_MISMATCH");
      expect((e as BridgeError).message).toMatch(/different account/);
    }
  });

  it("replaces only the relinked network's records", () => {
    const mainnetRecord: AccountAddress = {
      address: BC_TAPROOT,
      purposes: ["payment", "ordinals"],
      network: "mainnet",
      addressType: "p2tr",
      chainVerified: true,
    };
    const staleTestnet: AccountAddress = { ...mainnetRecord, address: TB_TAPROOT, network: "testnet4", purposes: ["ordinals"] };
    const account = { ...legacyXverse, addresses: [mainnetRecord, staleTestnet] };
    const addresses = relinkedAddresses(account, connected(TB_TAPROOT), "testnet4");
    expect(addresses[0]).toBe(mainnetRecord);
    expect(addresses.filter((a) => a.network === "testnet4")).toHaveLength(2);
  });
});
