import ecc from "@bitcoinerlab/secp256k1";

export function toXOnlyPubkey(pubkey: string): string {
  if (pubkey.length === 66) {
    return pubkey.slice(2);
  }
  if (pubkey.length === 64) {
    return pubkey;
  }
  throw new Error(`Invalid public key length: ${pubkey.length}`);
}

/**
 * Validate that a 64-char hex string is a valid x-only secp256k1 point —
 * i.e. its x-coordinate lifts to a real curve point. Arch's BIP-322
 * verifier rejects 32-byte values that don't lift with the cryptic error
 * `XOnlyPublicKey from slice error: malformed public key`, so we'd rather
 * catch it client-side and refresh the wallet identity before sending.
 */
export function isValidXOnlyPubkeyHex(hex: string): boolean {
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    return ecc.isXOnlyPoint(bytes);
  } catch {
    return false;
  }
}
