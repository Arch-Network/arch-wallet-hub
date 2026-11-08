import { describe, it, expect } from "vitest";
import { addressTypeOf, dedupeAddresses, resolveAccountAddresses } from "../account-addresses";
import type { AccountAddress, WalletAccount } from "../types";

const TB_TAPROOT = "tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m";
const BC_TAPROOT = "bc1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnns4f6ks5";
const TB_NESTED_SEGWIT = "2NBFNJTktNa7GZusGbDbGKRZTxdK9VVez3n";
const BC_NESTED_SEGWIT = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";

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

const xverseTestnet = account({
  kind: "external",
  authMethod: "external",
  externalProvider: "xverse",
  addresses: [
    record({ address: TB_NESTED_SEGWIT, purposes: ["payment"], addressType: "p2sh" }),
    record({ address: TB_TAPROOT, purposes: ["ordinals"] }),
  ],
});

describe("addressTypeOf", () => {
  it("classifies common script types by encoding", () => {
    expect(addressTypeOf(TB_TAPROOT)).toBe("p2tr");
    expect(addressTypeOf(BC_TAPROOT)).toBe("p2tr");
    expect(addressTypeOf("tb1qrn7tvhdf6wnh790384ahj56u0xaa0kqgautnnz")).toBe("p2wpkh");
    expect(addressTypeOf(TB_NESTED_SEGWIT)).toBe("p2sh");
    expect(addressTypeOf(BC_NESTED_SEGWIT)).toBe("p2sh");
    expect(addressTypeOf("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).toBe("p2pkh");
  });
});

describe("resolveAccountAddresses: native accounts", () => {
  it("re-encodes the Taproot address because Arch holds the key on both networks", () => {
    const r = resolveAccountAddresses(account({}), "mainnet");
    expect(r.identity).toBe(BC_TAPROOT);
    expect(r.payment).toBe(BC_TAPROOT);
    expect(r.ordinals).toBe(BC_TAPROOT);
    expect(r.all).toEqual([BC_TAPROOT]);
    expect(r.gap).toBeUndefined();
  });
});

describe("resolveAccountAddresses: Xverse", () => {
  it("keeps the payment and Ordinals addresses separate", () => {
    const r = resolveAccountAddresses(xverseTestnet, "testnet4");
    expect(r.payment).toBe(TB_NESTED_SEGWIT);
    expect(r.ordinals).toBe(TB_TAPROOT);
    expect(r.identity).toBe(TB_TAPROOT);
    expect(r.all).toEqual([TB_NESTED_SEGWIT, TB_TAPROOT]);
    expect(r.gap).toBeUndefined();
  });

  it("never rewrites a provider address for another network", () => {
    const r = resolveAccountAddresses(xverseTestnet, "mainnet");
    expect(r.all).toEqual([]);
    expect(r.identity).toBeNull();
    expect(r.payment).toBeNull();
    expect(r.gap).toBe("network-not-linked");
  });

  it("counts an address shared by both purposes once", () => {
    const shared = account({
      ...xverseTestnet,
      addresses: [
        record({ purposes: ["payment"] }),
        record({ purposes: ["ordinals"] }),
      ],
    });
    const r = resolveAccountAddresses(shared, "testnet4");
    expect(r.all).toEqual([TB_TAPROOT]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0].purposes.sort()).toEqual(["ordinals", "payment"]);
    expect(r.payment).toBe(TB_TAPROOT);
    expect(r.ordinals).toBe(TB_TAPROOT);
  });

  it("flags a pre-upgrade link that never stored the payment address", () => {
    const legacy = account({ kind: "external", authMethod: "external", externalProvider: "xverse" });
    const r = resolveAccountAddresses(legacy, "testnet4");
    expect(r.ordinals).toBe(TB_TAPROOT);
    expect(r.payment).toBeNull();
    expect(r.all).toEqual([TB_TAPROOT]);
    expect(r.records[0].chainVerified).toBe(false);
    expect(r.gap).toBe("payment-not-linked");
  });
});

describe("resolveAccountAddresses: UniSat", () => {
  it("uses its single address for every purpose", () => {
    const unisat = account({
      kind: "external",
      authMethod: "external",
      externalProvider: "unisat",
      addresses: [record({ purposes: ["payment", "ordinals"] })],
    });
    const r = resolveAccountAddresses(unisat, "testnet4");
    expect(r.payment).toBe(TB_TAPROOT);
    expect(r.ordinals).toBe(TB_TAPROOT);
    expect(r.all).toEqual([TB_TAPROOT]);
  });

  it("treats a legacy link as single-address, without claiming the chain was verified", () => {
    const legacy = account({ kind: "external", authMethod: "external", externalProvider: "unisat" });
    const r = resolveAccountAddresses(legacy, "testnet4");
    expect(r.payment).toBe(TB_TAPROOT);
    expect(r.records[0].chainVerified).toBe(false);
    expect(r.gap).toBeUndefined();
  });

  it("does not offer a legacy mainnet link on Testnet4", () => {
    const legacy = account({
      kind: "external",
      authMethod: "external",
      externalProvider: "unisat",
      btcAddress: BC_TAPROOT,
    });
    expect(resolveAccountAddresses(legacy, "testnet4").gap).toBe("network-not-linked");
    expect(resolveAccountAddresses(legacy, "mainnet").all).toEqual([BC_TAPROOT]);
  });
});

describe("dedupeAddresses", () => {
  it("only reports a merged record as chain-verified if every source was", () => {
    const merged = dedupeAddresses([
      record({ purposes: ["payment"], chainVerified: true }),
      record({ purposes: ["ordinals"], chainVerified: false }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].chainVerified).toBe(false);
  });

  it("keeps the same address on different networks apart", () => {
    const merged = dedupeAddresses([
      record({ network: "testnet4" }),
      record({ network: "mainnet" }),
    ]);
    expect(merged).toHaveLength(2);
  });
});
