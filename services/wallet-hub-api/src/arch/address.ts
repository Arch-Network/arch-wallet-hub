import { address as btcAddress } from "bitcoinjs-lib";
import bs58 from "bs58";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

export type ResolveArchAccountResult =
  | { kind: "arch"; archAccountAddress: string; archAccountAddressHex: string }
  | {
      kind: "taproot";
      taprootAddress: string;
      archAccountAddress: string;
      archAccountAddressHex: string;
      xOnlyPubkeyHex: string;
    };

/**
 * Resolve an Arch account address from a BTC taproot address or base58 pubkey.
 *
 * IMPORTANT: When used with a taproot address, the returned xOnlyPubkeyHex is the
 * **output key** (tweaked). For Arch transaction signing, you need the **internal key**
 * (untweaked). Use `archAccountFromInternalKey()` when the compressed public key is available.
 */
export function resolveArchAccountAddress(input: string): ResolveArchAccountResult {
  if (!input.startsWith("bc1") && !input.startsWith("tb1") && !input.startsWith("bcrt1")) {
    return { kind: "arch", archAccountAddress: input, archAccountAddressHex: input };
  }

  const decoded = btcAddress.fromBech32(input);
  if (decoded.version !== 1 || decoded.data.length !== 32) {
    throw new Error("Only Taproot (p2tr) bech32m addresses can be mapped to Arch accounts");
  }

  const xOnlyPubkey = Buffer.from(decoded.data);
  const xOnlyHex = xOnlyPubkey.toString("hex");
  const base58Addr = bs58.encode(xOnlyPubkey);

  return {
    kind: "taproot",
    taprootAddress: input,
    archAccountAddress: base58Addr,
    archAccountAddressHex: xOnlyHex,
    xOnlyPubkeyHex: xOnlyHex
  };
}

/**
 * Derive the Arch account address from a compressed (33-byte) or x-only (32-byte) public key.
 *
 * The Arch node treats account_keys[0] as a BIP-86 internal key and applies
 * `Address::p2tr(key, None, network)` for BIP-322 verification. Therefore the
 * Arch account identity MUST be the **internal** (untweaked) x-only key, NOT the
 * tweaked output key extracted from the taproot address.
 */
export function archAccountFromInternalKey(publicKeyHex: string): {
  internalXOnlyHex: string;
  archAccountAddress: string;
} {
  let xOnlyHex: string;
  if (publicKeyHex.length === 66) {
    xOnlyHex = publicKeyHex.slice(2);
  } else if (publicKeyHex.length === 64) {
    xOnlyHex = publicKeyHex;
  } else {
    throw new Error(`Invalid public key hex length: ${publicKeyHex.length} (expected 64 or 66)`);
  }
  const buf = Buffer.from(xOnlyHex, "hex");
  if (buf.length !== 32) throw new Error("Invalid public key: must be 32 bytes");
  return {
    internalXOnlyHex: xOnlyHex,
    archAccountAddress: bs58.encode(buf),
  };
}

function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = sha256(Buffer.from(tag, "utf8"));
  return sha256(Buffer.concat([tagHash, tagHash, data]));
}

/**
 * Apply the BIP-341 TapTweak (no script tree) to an internal x-only key and
 * return the tweaked output key (the x-only key that appears in a BIP-86
 * taproot address's witness program): Q = lift_x(P) + tagged_hash("TapTweak", P) * G.
 */
export function bip341TweakedOutputKeyHex(internalXOnlyHex: string): string {
  const internal = Buffer.from(internalXOnlyHex, "hex");
  if (internal.length !== 32) throw new Error("Internal key must be 32 bytes (x-only)");
  const tweak = taggedHash("TapTweak", internal);
  const P = schnorr.utils.lift_x(BigInt(`0x${internal.toString("hex")}`));
  const Q = P.add(secp256k1.ProjectivePoint.BASE.multiply(BigInt(`0x${Buffer.from(tweak).toString("hex")}`)));
  return Q.toAffine().x.toString(16).padStart(64, "0");
}

export type ArchAccountFromWalletKeyResult =
  | { ok: true; internalXOnlyHex: string; archAccountAddress: string }
  | { ok: false; reason: string };

/**
 * Derive the CANONICAL Arch account identity from a wallet-supplied public key
 * (compressed 33-byte or x-only 32-byte hex), verifying it actually corresponds
 * to the given BIP-86 taproot address: the BIP-341 tweak of the internal key
 * must equal the address's witness program (output key).
 *
 * This is the ONLY safe way to register an Arch identity for an external
 * wallet: decoding the taproot address yields the TWEAKED output key, which is
 * NOT the account key the Arch node verifies signatures against.
 */
export function archAccountFromWalletPublicKey(params: {
  publicKeyHex: string;
  taprootAddress: string;
}): ArchAccountFromWalletKeyResult {
  let internal;
  try {
    internal = archAccountFromInternalKey(params.publicKeyHex);
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? "Invalid public key" };
  }

  let outputKeyHex: string;
  try {
    const decoded = btcAddress.fromBech32(params.taprootAddress);
    if (decoded.version !== 1 || decoded.data.length !== 32) {
      return { ok: false, reason: "Address is not a taproot (p2tr) bech32m address" };
    }
    outputKeyHex = Buffer.from(decoded.data).toString("hex");
  } catch {
    return { ok: false, reason: "Address is not a valid bech32m address" };
  }

  let tweakedHex: string;
  try {
    tweakedHex = bip341TweakedOutputKeyHex(internal.internalXOnlyHex);
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? "Public key is not a valid x-only point" };
  }

  if (tweakedHex !== outputKeyHex) {
    return {
      ok: false,
      reason: "Public key does not correspond to the taproot address (BIP-341 tweak mismatch)"
    };
  }

  return {
    ok: true,
    internalXOnlyHex: internal.internalXOnlyHex,
    archAccountAddress: internal.archAccountAddress
  };
}

/**
 * Re-encode a taproot (bech32m v1) address for a different network.
 * tb1p... → bc1p... (mainnet) or bc1p... → tb1p... (testnet).
 * Returns the original address unchanged if it already matches the target
 * or is not a recognised taproot address.
 */
export function reEncodeTaprootForNetwork(
  address: string,
  targetNetwork: "mainnet" | "testnet"
): string {
  const isTestnet = address.startsWith("tb1p");
  const isMainnet = address.startsWith("bc1p");
  if (!isTestnet && !isMainnet) return address;
  if (targetNetwork === "mainnet" && isMainnet) return address;
  if (targetNetwork === "testnet" && isTestnet) return address;

  const decoded = btcAddress.fromBech32(address);
  if (decoded.version !== 1 || decoded.data.length !== 32) return address;

  const prefix = targetNetwork === "mainnet" ? "bc" : "tb";
  return btcAddress.toBech32(decoded.data, decoded.version, prefix);
}
