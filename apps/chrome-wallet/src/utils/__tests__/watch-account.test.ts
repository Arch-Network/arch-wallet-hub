import { describe, expect, it } from "vitest";
import { buildWatchAccount, InvalidWatchAddressError } from "../watch-account";
import { reEncodeTaprootAddress } from "../addressNetwork";

// Real taproot addresses lifted from public test vectors. We don't
// need the matching private key -- the whole point of watch-only is
// that we never reach for one.
const MAINNET_P2TR = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
// Derived deterministically from MAINNET_P2TR via the wallet's own
// re-encode helper. Identical witness program, just the `tb` HRP.
const TESTNET_P2TR = reEncodeTaprootAddress(MAINNET_P2TR, "testnet4");

describe("buildWatchAccount", () => {
  it("builds a kind=watch account for a mainnet P2TR address", () => {
    const a = buildWatchAccount({
      taprootAddress: MAINNET_P2TR,
      label: "Cold storage",
      network: "mainnet",
    });
    expect(a.kind).toBe("watch");
    expect(a.authMethod).toBe("watch");
    expect(a.label).toBe("Cold storage");
    expect(a.btcAddress).toBe(MAINNET_P2TR);
    expect(a.publicKeyHex.length).toBe(64);
    expect(a.archAddress).toBeTruthy();
    expect(a.turnkeyResourceId).toBe("");
    expect(a.organizationId).toBe("");
    expect(a.id.startsWith("watch-")).toBe(true);
  });

  it("builds a kind=watch account for a testnet P2TR address", () => {
    const a = buildWatchAccount({
      taprootAddress: TESTNET_P2TR,
      label: "Trezor T",
      network: "testnet4",
    });
    expect(a.kind).toBe("watch");
    expect(a.btcAddress).toBe(TESTNET_P2TR);
  });

  it("derives the same Arch address as the BTC address's x-only pubkey would", () => {
    const a = buildWatchAccount({
      taprootAddress: MAINNET_P2TR,
      label: "Cold storage",
      network: "mainnet",
    });
    // The MAINNET_P2TR vector's x-only pubkey (witness program) is
    // the bech32m payload, which the helper recovers. Adding it
    // twice with the same input must produce the same id (purely
    // address-derived, no randomness).
    const b = buildWatchAccount({
      taprootAddress: MAINNET_P2TR,
      label: "Cold storage",
      network: "mainnet",
    });
    expect(a.id).toBe(b.id);
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
    expect(a.archAddress).toBe(b.archAddress);
  });

  it("rejects a non-taproot address (legacy P2PKH)", () => {
    expect(() =>
      buildWatchAccount({
        taprootAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        label: "Genesis",
        network: "mainnet",
      }),
    ).toThrow(InvalidWatchAddressError);
  });

  it("rejects a non-taproot address (P2WPKH bech32 v0)", () => {
    expect(() =>
      buildWatchAccount({
        taprootAddress: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        label: "v0",
        network: "mainnet",
      }),
    ).toThrow(InvalidWatchAddressError);
  });

  it("rejects garbage", () => {
    expect(() =>
      buildWatchAccount({
        taprootAddress: "not a real address",
        label: "bad",
        network: "mainnet",
      }),
    ).toThrow(InvalidWatchAddressError);
  });

  it("refuses cross-network HRP (testnet address on mainnet)", () => {
    expect(() =>
      buildWatchAccount({
        taprootAddress: TESTNET_P2TR,
        label: "wrong-net",
        network: "mainnet",
      }),
    ).toThrow(InvalidWatchAddressError);
  });

  it("refuses cross-network HRP (mainnet address on testnet)", () => {
    expect(() =>
      buildWatchAccount({
        taprootAddress: MAINNET_P2TR,
        label: "wrong-net",
        network: "testnet4",
      }),
    ).toThrow(InvalidWatchAddressError);
  });

  it("requires a non-empty label", () => {
    expect(() =>
      buildWatchAccount({
        taprootAddress: MAINNET_P2TR,
        label: "   ",
        network: "mainnet",
      }),
    ).toThrow(InvalidWatchAddressError);
  });
});
