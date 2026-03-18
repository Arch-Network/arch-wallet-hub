import { address as btcAddress } from "bitcoinjs-lib";
import bs58 from "bs58";

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
