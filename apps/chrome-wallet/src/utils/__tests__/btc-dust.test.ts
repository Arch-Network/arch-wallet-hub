/**
 * Tests for per-script-type dust limits.
 *
 * The canonical values match Bitcoin Core's GetDustThreshold() with
 * the default -dustrelayfee=3000. Verifying these against real
 * mainnet+testnet address samples so a typo in the classifier or
 * threshold table is caught immediately.
 */
import { describe, it, expect } from "vitest";
import {
  classifyBtcAddress,
  dustThresholdForAddress,
  DUST_FALLBACK_SATS
} from "../btc-dust";

describe("classifyBtcAddress", () => {
  it("classifies mainnet P2PKH (1...)", () => {
    expect(classifyBtcAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe("p2pkh");
  });

  it("classifies testnet P2PKH (m.../n...)", () => {
    expect(classifyBtcAddress("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn")).toBe("p2pkh");
    expect(classifyBtcAddress("n2eMqTT929pb1RDNuqEnxdaLau1rxy3efi")).toBe("p2pkh");
  });

  it("classifies mainnet P2SH (3...)", () => {
    expect(classifyBtcAddress("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toBe("p2sh");
  });

  it("classifies testnet P2SH (2...)", () => {
    expect(classifyBtcAddress("2N2JD6wb56AfK4tfmM6PwdVmoYk2dCKf4Br")).toBe("p2sh");
  });

  it("classifies mainnet P2WPKH (bc1q... 42-char)", () => {
    expect(classifyBtcAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe("p2wpkh");
  });

  it("classifies testnet P2WPKH (tb1q... 42-char)", () => {
    expect(classifyBtcAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toBe("p2wpkh");
  });

  it("classifies P2WSH (bc1q... 62-char) distinct from P2WPKH", () => {
    expect(
      classifyBtcAddress(
        "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3"
      )
    ).toBe("p2wsh");
  });

  it("classifies mainnet P2TR (bc1p... bech32m)", () => {
    expect(
      classifyBtcAddress(
        "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"
      )
    ).toBe("p2tr");
  });

  it("classifies testnet P2TR (tb1p... bech32m)", () => {
    expect(
      classifyBtcAddress("tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m")
    ).toBe("p2tr");
  });

  it("returns 'unknown' for garbage input", () => {
    expect(classifyBtcAddress("")).toBe("unknown");
    expect(classifyBtcAddress("not-an-address")).toBe("unknown");
    expect(classifyBtcAddress("0xdeadbeef")).toBe("unknown");
  });

  it("is case-insensitive on bech32 prefixes", () => {
    expect(classifyBtcAddress("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")).toBe("p2wpkh");
  });

  it("classifies regtest bech32 addresses", () => {
    expect(
      classifyBtcAddress("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7k5atyhq")
    ).toBe("p2wpkh");
  });
});

describe("dustThresholdForAddress", () => {
  it("returns 546 for P2PKH (legacy)", () => {
    expect(dustThresholdForAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(546);
  });

  it("returns 540 for P2SH", () => {
    expect(dustThresholdForAddress("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toBe(540);
  });

  it("returns 294 for P2WPKH (the screenshot case)", () => {
    // This is the case the user hit: sending to a tb1q... recipient
    // got rejected at 502 sats, but the policy floor is 294.
    expect(
      dustThresholdForAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")
    ).toBe(294);
  });

  it("returns 330 for P2TR", () => {
    expect(
      dustThresholdForAddress(
        "tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m"
      )
    ).toBe(330);
  });

  it("returns 330 for P2WSH (same policy floor as P2TR)", () => {
    expect(
      dustThresholdForAddress(
        "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3"
      )
    ).toBe(330);
  });

  it("falls back to 546 (strictest) on unknown address shapes", () => {
    expect(dustThresholdForAddress("not-an-address")).toBe(DUST_FALLBACK_SATS);
    expect(dustThresholdForAddress("")).toBe(DUST_FALLBACK_SATS);
  });

  it("matches the canonical Bitcoin Core policy table", () => {
    // Pinned table reproducible from Bitcoin Core's source.
    // If any line here drifts, the wallet has diverged from network
    // policy and would either reject relayable txs (cheap to fix)
    // or emit non-relayable txs (a real bug).
    const cases: Array<[string, number]> = [
      ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", 546],
      ["3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", 540],
      ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", 294],
      ["bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr", 330]
    ];
    for (const [addr, expected] of cases) {
      expect(dustThresholdForAddress(addr)).toBe(expected);
    }
  });
});
