import { describe, it, expect } from "vitest";
import bs58 from "bs58";
import { TESTNET_CONFIG } from "@arch/swap-engine";
import { lookupKnownToken } from "../known-tokens";

/**
 * Regression tests for the registry's mint-keyed lookup.
 *
 * The Swap balance loader matches the user's APL token rows against
 * the engine's swappable mints by going through `lookupKnownToken`.
 * Earlier we matched by `symbol` instead — that silently dropped the
 * BTC balance the moment we added the display override
 * BTC → "aBTC", because the registry returned `symbol: "aBTC"` while
 * the engine's `availableSymbols` still contained `"BTC"`.
 *
 * The contract these tests pin down:
 *
 *   1. `lookupKnownToken` accepts both hex AND base58 mints.
 *   2. The returned meta's `mintHex` matches the engine's `mint`
 *      verbatim (lowercased), so callers can route by mint.
 *   3. The display override is applied — the meta's `symbol` is the
 *      override, not the engine's routing key.
 */

function hexToBase58(hex: string): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bs58.encode(bytes);
}

describe("known-tokens registry", () => {
  const btc = TESTNET_CONFIG.tokens.BTC;
  const usdc = TESTNET_CONFIG.tokens.USDC;
  if (!btc || !usdc) throw new Error("Engine testnet config missing BTC/USDC");

  it("resolves the testnet BTC mint by hex", () => {
    const hit = lookupKnownToken(btc.mint, "testnet4");
    expect(hit).not.toBeNull();
    expect(hit!.mintHex).toBe(btc.mint.toLowerCase());
  });

  it("resolves the testnet BTC mint by base58", () => {
    const base58 = hexToBase58(btc.mint);
    const hit = lookupKnownToken(base58, "testnet4");
    expect(hit).not.toBeNull();
    expect(hit!.mintHex).toBe(btc.mint.toLowerCase());
    expect(hit!.mintBase58).toBe(base58);
  });

  it("applies the aBTC display override to the BTC entry", () => {
    // Pinned because the Dashboard portfolio + Swap UI labels read
    // off this field. Dropping the override would surface generic
    // "Bitcoin" everywhere and confuse holders of native sats.
    const hit = lookupKnownToken(btc.mint, "testnet4")!;
    expect(hit.symbol).toBe("aBTC");
    expect(hit.name).toBe("Arch Bitcoin");
  });

  it("leaves USDC unchanged by the override table", () => {
    const hit = lookupKnownToken(usdc.mint, "testnet4")!;
    expect(hit.symbol).toBe("USDC");
  });

  it("returns null for an unknown mint", () => {
    expect(
      lookupKnownToken(
        "0000000000000000000000000000000000000000000000000000000000000000",
        "testnet4",
      ),
    ).toBeNull();
  });
});
