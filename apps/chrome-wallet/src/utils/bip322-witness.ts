/**
 * BIP-322 witness → 64-byte Schnorr hex.
 *
 * Linked external wallets (Xverse / UniSat) return a BIP-322 simple witness
 * blob from `signMessage`. Arch dapps and ANS expect the inner 64-byte
 * (r||s) Schnorr hex that Turnkey's `signArchMessageHash` already returns.
 * Ported from the ANS / arch-swap-engine extract path verified with those
 * wallets.
 */

import { SignatureUtil } from "@arch-network/arch-sdk";

function decodeBase64(input: string): Uint8Array {
  const str = atob(input);
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) {
    out[i] = str.charCodeAt(i);
  }
  return out;
}

function decodeHex(input: string): Uint8Array {
  const clean = input.startsWith("0x") || input.startsWith("0X") ? input.slice(2) : input;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("Cannot decode signature: not valid hex.");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

function isHex(value: string): boolean {
  const clean = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return clean.length > 0 && clean.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(clean);
}

/** Prefer hex when ambiguous — UniSat may return hex that atob() would also accept. */
export function decodeRawWalletSignature(raw: string): Uint8Array {
  if (isHex(raw)) return decodeHex(raw);
  try {
    return decodeBase64(raw);
  } catch {
    throw new Error("Cannot decode signature: not base64 or hex.");
  }
}

function readCompactSize(
  bytes: Uint8Array,
  offset: number,
): { value: number; nextOffset: number } | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset]!;
  if (first < 0xfd) return { value: first, nextOffset: offset + 1 };
  if (first === 0xfd) {
    if (offset + 2 >= bytes.length) return null;
    const value = bytes[offset + 1]! | (bytes[offset + 2]! << 8);
    return { value, nextOffset: offset + 3 };
  }
  if (first === 0xfe) {
    if (offset + 4 >= bytes.length) return null;
    const value =
      bytes[offset + 1]! |
      (bytes[offset + 2]! << 8) |
      (bytes[offset + 3]! << 16) |
      (bytes[offset + 4]! << 24);
    return { value, nextOffset: offset + 5 };
  }
  return null;
}

function parseWitnessStack(bytes: Uint8Array): Uint8Array[] | null {
  const countResult = readCompactSize(bytes, 0);
  if (!countResult || countResult.value <= 0 || countResult.value > 16) return null;

  let offset = countResult.nextOffset;
  const items: Uint8Array[] = [];
  for (let i = 0; i < countResult.value; i += 1) {
    const size = readCompactSize(bytes, offset);
    if (!size) return null;
    offset = size.nextOffset;
    if (size.value < 0 || offset + size.value > bytes.length) return null;
    items.push(bytes.slice(offset, offset + size.value));
    offset += size.value;
  }
  return offset === bytes.length ? items : null;
}

/** First witness stack item, or null when `raw` is not a witness blob. */
export function getWalletWitnessSignatureItem(raw: string): Uint8Array | null {
  const bytes = decodeRawWalletSignature(raw);
  const witnessItems = parseWitnessStack(bytes);
  if (!witnessItems || witnessItems.length === 0) return null;
  return witnessItems[0] ?? null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `SignatureUtil.adjustSignature` only accepts 64-byte Schnorr. BIP-322
 * wallets sometimes append a sighash byte (65 total); strip it first.
 */
function toAdjustableSchnorr(sig: Uint8Array): Uint8Array {
  if (sig.length === 65) return sig.slice(0, 64);
  return sig;
}

/**
 * Normalize a wallet signature payload to 64-byte Schnorr hex.
 *
 * Primary path: parse BIP-322 simple witness, take stack item 0, adjust.
 * Fallback: adjust the raw decoded bytes (plain hex / base64 Schnorr).
 */
export function extractSchnorrHexFromWalletSignature(rawSignature: string): string {
  const witnessItem = getWalletWitnessSignatureItem(rawSignature);
  if (witnessItem) {
    const adjusted = SignatureUtil.adjustSignature(toAdjustableSchnorr(witnessItem));
    if (adjusted.length === 64) return bytesToHex(adjusted);
  }

  const rawBytes = decodeRawWalletSignature(rawSignature);
  const adjusted = SignatureUtil.adjustSignature(toAdjustableSchnorr(rawBytes));
  if (adjusted.length === 64) return bytesToHex(adjusted);

  throw new Error(
    `Failed to extract a valid 64-byte signature (witness=${witnessItem?.length ?? "none"}, raw=${rawBytes.length}).`,
  );
}
