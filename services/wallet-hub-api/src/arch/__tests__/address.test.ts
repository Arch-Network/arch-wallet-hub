import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import bs58 from "bs58";
import { secp256k1 } from "@noble/curves/secp256k1";
import { address as btcAddress } from "bitcoinjs-lib";
import {
  archAccountFromInternalKey,
  archAccountFromWalletPublicKey,
  bip341TweakedOutputKeyHex,
  resolveArchAccountAddress
} from "../address.js";

/**
 * Real-world vector from the Unisat derivation bug report:
 *
 *   - CANONICAL Arch identity (untweaked internal x-only key, what
 *     Unisat's getPublicKey() exposes and what the Arch node verifies
 *     signatures against): 9futhVvDtou9SiUHUK31kQEzpR9yk81HmZrcFbtHAvFu
 *   - WRONGLY-REGISTERED identity (BIP-341 tweaked taproot output key,
 *     decoded from the taproot address): 9uCzmLZXTdKQup3MenMwr2UdozfXp2R4xXzVarQTnhT5
 *
 * Applying the BIP-341 TapTweak (no script tree) to the first MUST yield
 * the second; that equality is the root cause of the bug.
 */
const CANONICAL_ARCH_ADDRESS = "9futhVvDtou9SiUHUK31kQEzpR9yk81HmZrcFbtHAvFu";
const TWEAKED_ARCH_ADDRESS = "9uCzmLZXTdKQup3MenMwr2UdozfXp2R4xXzVarQTnhT5";

const canonicalXOnlyHex = Buffer.from(bs58.decode(CANONICAL_ARCH_ADDRESS)).toString("hex");
const tweakedXOnlyHex = Buffer.from(bs58.decode(TWEAKED_ARCH_ADDRESS)).toString("hex");

/** The user's real taproot address is p2tr(internal) => witness program = tweaked key. */
const vectorTaprootAddress = btcAddress.toBech32(
  Buffer.from(tweakedXOnlyHex, "hex"),
  1,
  "bc"
);

describe("bip341TweakedOutputKeyHex (TapTweak math)", () => {
  it("maps the bug report's canonical key to the wrongly-registered tweaked key", () => {
    expect(bip341TweakedOutputKeyHex(canonicalXOnlyHex)).toBe(tweakedXOnlyHex);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => bip341TweakedOutputKeyHex("abcd")).toThrow();
  });
});

describe("archAccountFromInternalKey", () => {
  it("accepts a 32-byte x-only key as-is", () => {
    const res = archAccountFromInternalKey(canonicalXOnlyHex);
    expect(res.internalXOnlyHex).toBe(canonicalXOnlyHex);
    expect(res.archAccountAddress).toBe(CANONICAL_ARCH_ADDRESS);
  });

  it("drops the parity byte of a compressed 33-byte key (02 and 03)", () => {
    for (const parity of ["02", "03"]) {
      const res = archAccountFromInternalKey(`${parity}${canonicalXOnlyHex}`);
      expect(res.internalXOnlyHex).toBe(canonicalXOnlyHex);
      expect(res.archAccountAddress).toBe(CANONICAL_ARCH_ADDRESS);
    }
  });

  it("rejects other lengths", () => {
    expect(() => archAccountFromInternalKey(canonicalXOnlyHex.slice(2))).toThrow();
    expect(() => archAccountFromInternalKey(`0202${canonicalXOnlyHex}`)).toThrow();
  });
});

describe("archAccountFromWalletPublicKey (canonical link derivation)", () => {
  it("derives the canonical (untweaked) identity for the bug-report wallet", () => {
    const res = archAccountFromWalletPublicKey({
      publicKeyHex: canonicalXOnlyHex,
      taprootAddress: vectorTaprootAddress
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.archAccountAddress).toBe(CANONICAL_ARCH_ADDRESS);
      expect(res.archAccountAddress).not.toBe(TWEAKED_ARCH_ADDRESS);
      expect(res.internalXOnlyHex).toBe(canonicalXOnlyHex);
    }
  });

  it("accepts the compressed 33-byte form of the same key", () => {
    const res = archAccountFromWalletPublicKey({
      publicKeyHex: `02${canonicalXOnlyHex}`,
      taprootAddress: vectorTaprootAddress
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.archAccountAddress).toBe(CANONICAL_ARCH_ADDRESS);
  });

  it("is deterministic/idempotent (re-linking derives the same identity)", () => {
    const a = archAccountFromWalletPublicKey({
      publicKeyHex: canonicalXOnlyHex,
      taprootAddress: vectorTaprootAddress
    });
    const b = archAccountFromWalletPublicKey({
      publicKeyHex: canonicalXOnlyHex,
      taprootAddress: vectorTaprootAddress
    });
    expect(a).toEqual(b);
  });

  it("rejects a public key that does not correspond to the address (tweak mismatch)", () => {
    const otherKey = Buffer.from(
      secp256k1.getPublicKey(crypto.randomBytes(32), true)
    ).toString("hex");
    const res = archAccountFromWalletPublicKey({
      publicKeyHex: otherKey,
      taprootAddress: vectorTaprootAddress
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/tweak mismatch/);
  });

  it("rejects the TWEAKED output key itself (cannot be passed off as the internal key)", () => {
    const res = archAccountFromWalletPublicKey({
      publicKeyHex: tweakedXOnlyHex,
      taprootAddress: vectorTaprootAddress
    });
    expect(res.ok).toBe(false);
  });

  it("rejects non-taproot addresses", () => {
    const res = archAccountFromWalletPublicKey({
      publicKeyHex: canonicalXOnlyHex,
      taprootAddress: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
    });
    expect(res.ok).toBe(false);
  });

  it("round-trips for a freshly generated BIP-86-style keypair", () => {
    const priv = crypto.randomBytes(32);
    const compressed = Buffer.from(secp256k1.getPublicKey(priv, true)).toString("hex");
    const internalXOnly = compressed.slice(2);
    const outputKeyHex = bip341TweakedOutputKeyHex(internalXOnly);
    const addr = btcAddress.toBech32(Buffer.from(outputKeyHex, "hex"), 1, "bc");

    const res = archAccountFromWalletPublicKey({ publicKeyHex: compressed, taprootAddress: addr });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.internalXOnlyHex).toBe(internalXOnly);
      expect(res.archAccountAddress).toBe(bs58.encode(Buffer.from(internalXOnly, "hex")));
    }
  });
});

describe("resolveArchAccountAddress (legacy address-decode)", () => {
  it("returns the TWEAKED key for a taproot address — the historical bug this fix removes from the link path", () => {
    const res = resolveArchAccountAddress(vectorTaprootAddress);
    expect(res.kind).toBe("taproot");
    expect(res.archAccountAddress).toBe(TWEAKED_ARCH_ADDRESS);
    expect(res.archAccountAddress).not.toBe(CANONICAL_ARCH_ADDRESS);
  });

  it("passes through base58 arch addresses unchanged", () => {
    const res = resolveArchAccountAddress(CANONICAL_ARCH_ADDRESS);
    expect(res.kind).toBe("arch");
    expect(res.archAccountAddress).toBe(CANONICAL_ARCH_ADDRESS);
  });
});
