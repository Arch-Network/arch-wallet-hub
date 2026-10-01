import { describe, expect, it } from "vitest";
import { address as bitcoinAddress } from "bitcoinjs-lib";
import bs58 from "bs58";
import { normalizePushAddresses } from "../addresses.js";

describe("normalizePushAddresses", () => {
  const arch = bs58.encode(Buffer.alloc(32, 1));
  const btc = bitcoinAddress.toBech32(Buffer.alloc(32, 2), 1, "tb");

  it("accepts Arch owner and Bitcoin taproot syntax without ownership checks", () => {
    expect(
      normalizePushAddresses([
        { chain: "arch", address: arch },
        { chain: "btc", address: btc },
      ]),
    ).toEqual([
      { chain: "arch", address: arch },
      { chain: "btc", address: btc },
    ]);
  });

  it("trims and de-duplicates the full address set", () => {
    expect(
      normalizePushAddresses([
        { chain: "arch", address: ` ${arch} ` },
        { chain: "arch", address: arch },
      ]),
    ).toEqual([{ chain: "arch", address: arch }]);
  });

  it("rejects malformed and non-taproot addresses", () => {
    expect(() =>
      normalizePushAddresses([{ chain: "arch", address: "not-base58" }]),
    ).toThrow("Invalid arch address");
    expect(() =>
      normalizePushAddresses([
        {
          chain: "btc",
          address: bitcoinAddress.toBech32(Buffer.alloc(20, 3), 0, "tb"),
        },
      ]),
    ).toThrow("Invalid btc address");
  });
});
