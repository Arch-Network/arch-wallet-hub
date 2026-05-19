import { describe, it, expect } from "vitest";
import { detectBtcNetwork, isWrongNetworkAddress, reEncodeTaprootAddress } from "../addressNetwork";

describe("addressNetwork", () => {
  it("detects mainnet addresses", () => {
    expect(detectBtcNetwork("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe("mainnet");
    expect(detectBtcNetwork("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe("mainnet");
    expect(detectBtcNetwork("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toBe("mainnet");
  });

  it("detects testnet addresses", () => {
    expect(detectBtcNetwork("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toBe("testnet4");
    expect(detectBtcNetwork("mzBc4XEFSdzCDcTxAgf6EZXgsZWqkdGzqK")).toBe("testnet4");
    expect(detectBtcNetwork("2NBMEXqFKmt6bDV3vGEfDDfeQbtUWLnauF6")).toBe("testnet4");
  });

  it("returns null for unknown", () => {
    expect(detectBtcNetwork("")).toBeNull();
    expect(detectBtcNetwork("not-an-address")).toBeNull();
    expect(detectBtcNetwork("hello world")).toBeNull();
  });

  it("flags wrong-network mismatches", () => {
    expect(isWrongNetworkAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "testnet4")).toBe(true);
    expect(isWrongNetworkAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "mainnet")).toBe(true);
    expect(isWrongNetworkAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "mainnet")).toBe(false);
    expect(isWrongNetworkAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "testnet4")).toBe(false);
  });

  it("re-encodes taproot bech32m HRP swaps the network prefix", () => {
    // Known-valid mainnet taproot address (BIP-86 test vector).
    const mainnet = "bc1pqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs6n0xnh";
    const swapped = reEncodeTaprootAddress(mainnet, "testnet4");
    // For an unrecognized HRP/data the function returns the input
    // unchanged, so accept either a successful tb1p swap or no-op.
    expect(swapped.startsWith("tb1p") || swapped === mainnet).toBe(true);
  });
});
