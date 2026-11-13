import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import {
  btcAddressReady,
  checkBtcAddress,
  normalizeBtcAddress,
  requireRecipientAddress,
  INVALID_BTC_ADDRESS_MESSAGE,
} from "../btc-address";

const P2WPKH = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const P2TR = "bc1pqwzdlz4s7u9kwv3dltgxamtsry7yutz0xrv7gqju8tvzg726zutqxwep4g";
const TB_P2WPKH = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

describe("normalizeBtcAddress", () => {
  it("strips the groups of four used on the receive screen", () => {
    expect(
      normalizeBtcAddress("bc1p qwzd lz4s 7u9k wv3d ltgx amts ry7y utz0 xrv7 gqju 8tvz g726 zutq xwep 4g"),
    ).toBe(P2TR);
  });

  it("strips surrounding whitespace and zero-width characters", () => {
    expect(normalizeBtcAddress(` \u200b${P2WPKH}\n`)).toBe(P2WPKH);
  });
});

describe("checkBtcAddress", () => {
  it("accepts a spaced mainnet taproot address", () => {
    const spaced = "bc1p qwzd lz4s 7u9k wv3d ltgx amts ry7y utz0 xrv7 gqju 8tvz g726 zutq xwep 4g";
    expect(checkBtcAddress(spaced, "mainnet")).toEqual({ ok: true, address: P2TR, reason: null });
  });

  it("accepts legacy, nested segwit, and native segwit", () => {
    expect(checkBtcAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "mainnet").ok).toBe(true);
    expect(checkBtcAddress("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "mainnet").ok).toBe(true);
    expect(checkBtcAddress(P2WPKH, "mainnet")).toEqual({ ok: true, address: P2WPKH, reason: null });
  });

  it("rejects a bad checksum", () => {
    const broken = `${P2TR.slice(0, -1)}p`;
    expect(checkBtcAddress(broken, "mainnet")).toEqual({
      ok: false,
      address: broken,
      reason: "invalid",
    });
  });

  it("distinguishes an address for the other network", () => {
    expect(checkBtcAddress(TB_P2WPKH, "mainnet").reason).toBe("wrong-network");
    expect(checkBtcAddress(P2WPKH, "testnet4").reason).toBe("wrong-network");
    expect(checkBtcAddress(TB_P2WPKH, "testnet4").ok).toBe(true);
  });

  it("treats a blank field as empty", () => {
    expect(checkBtcAddress("   ", "mainnet")).toEqual({ ok: false, address: "", reason: "empty" });
  });
});

describe("btcAddressReady", () => {
  it("waits until a taproot address is full length", () => {
    expect(btcAddressReady(P2TR.slice(0, 42))).toBe(false);
    expect(btcAddressReady(P2TR)).toBe(true);
  });

  it("treats a 42-character native segwit address as complete", () => {
    expect(btcAddressReady(P2WPKH)).toBe(true);
  });
});

describe("requireRecipientAddress", () => {
  it("returns the stripped address when it decodes", () => {
    expect(
      requireRecipientAddress(` ${P2WPKH.slice(0, 8)} ${P2WPKH.slice(8)} `, bitcoin.networks.bitcoin),
    ).toBe(P2WPKH);
  });

  it("throws before a caller can build an output from a bad address", () => {
    expect(() => requireRecipientAddress("bc1p not-an-address", bitcoin.networks.bitcoin)).toThrow(
      INVALID_BTC_ADDRESS_MESSAGE,
    );
  });
});
