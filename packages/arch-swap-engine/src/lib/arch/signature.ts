import { bytesToHex } from "@/lib/arch/hex";
import { isHex } from "@/lib/arch/base58";

function decodeBase64(input: string): Uint8Array {
  const str = atob(input);
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) {
    out[i] = str.charCodeAt(i);
  }
  return out;
}

function decodeHex(input: string): Uint8Array {
  const out = new Uint8Array(input.length / 2);
  for (let i = 0; i < input.length; i += 2) {
    out[i / 2] = parseInt(input.slice(i, i + 2), 16);
  }
  return out;
}

const SECP256K1_CURVE_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP256K1_CURVE_HALF_ORDER = SECP256K1_CURVE_ORDER >> 1n;

function bytesToBigInt(bytes: Uint8Array): bigint {
  if (bytes.length === 0) {
    return 0n;
  }
  return BigInt(`0x${bytesToHex(bytes)}`);
}

function bigIntToFixed32Bytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  return decodeHex(hex);
}

function normalizeCompactSignatureLowS(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) {
    return signature;
  }

  const r = signature.slice(0, 32);
  const s = signature.slice(32);
  const sBigInt = bytesToBigInt(s);

  if (sBigInt === 0n || sBigInt >= SECP256K1_CURVE_ORDER) {
    return signature;
  }

  if (sBigInt > SECP256K1_CURVE_HALF_ORDER) {
    const normalizedS = SECP256K1_CURVE_ORDER - sBigInt;
    return Uint8Array.from([...r, ...bigIntToFixed32Bytes(normalizedS)]);
  }

  return signature;
}

export function decodeRawWalletSignature(raw: string): Uint8Array {
  // Prefer hex decoding when input is clearly hex-like. Some wallet signatures
  // (notably UniSat) may be returned as hex and can be incorrectly accepted by atob().
  if (isHex(raw)) {
    return decodeHex(raw);
  }

  try {
    return decodeBase64(raw);
  } catch {
    throw new Error("Cannot decode signature: not base64 or hex.");
  }
}

function trimLeadingZeros(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  let offset = 0;
  while (offset < bytes.length - 1 && bytes[offset] === 0) {
    offset += 1;
  }
  return bytes.slice(offset);
}

function readCompactSize(
  bytes: Uint8Array,
  offset: number,
): { value: number; nextOffset: number } | null {
  if (offset >= bytes.length) {
    return null;
  }

  const first = bytes[offset]!;
  if (first < 0xfd) {
    return { value: first, nextOffset: offset + 1 };
  }

  if (first === 0xfd) {
    if (offset + 2 >= bytes.length) {
      return null;
    }
    const value = bytes[offset + 1]! | (bytes[offset + 2]! << 8);
    return { value, nextOffset: offset + 3 };
  }

  if (first === 0xfe) {
    if (offset + 4 >= bytes.length) {
      return null;
    }
    const value =
      bytes[offset + 1]!
      | (bytes[offset + 2]! << 8)
      | (bytes[offset + 3]! << 16)
      | (bytes[offset + 4]! << 24);
    return { value, nextOffset: offset + 5 };
  }

  return null;
}

function parseWitnessStack(bytes: Uint8Array): Uint8Array[] | null {
  const countResult = readCompactSize(bytes, 0);
  if (!countResult || countResult.value <= 0 || countResult.value > 16) {
    return null;
  }

  let offset = countResult.nextOffset;
  const items: Uint8Array[] = [];

  for (let i = 0; i < countResult.value; i += 1) {
    const size = readCompactSize(bytes, offset);
    if (!size) {
      return null;
    }

    offset = size.nextOffset;
    if (size.value < 0 || offset + size.value > bytes.length) {
      return null;
    }

    items.push(bytes.slice(offset, offset + size.value));
    offset += size.value;
  }

  return offset === bytes.length ? items : null;
}

export function getWalletWitnessSignatureItem(raw: string): Uint8Array | null {
  const bytes = decodeRawWalletSignature(raw);
  const witnessItems = parseWitnessStack(bytes);
  if (!witnessItems || witnessItems.length === 0) {
    return null;
  }

  return witnessItems[0] ?? null;
}

export function getWalletWitnessPubkey(raw: string): string | null {
  const bytes = decodeRawWalletSignature(raw);
  const witnessItems = parseWitnessStack(bytes);
  if (!witnessItems || witnessItems.length < 2) {
    return null;
  }

  const pubkey = witnessItems[1];
  if (!pubkey) {
    return null;
  }

  if (pubkey.length === 32) {
    return bytesToHex(pubkey);
  }

  if (pubkey.length === 33 && (pubkey[0] === 0x02 || pubkey[0] === 0x03)) {
    return bytesToHex(pubkey);
  }

  return null;
}

function decodeDerSignatureToCompact(signature: Uint8Array): Uint8Array | null {
  if (signature.length < 8 || signature[0] !== 0x30) {
    return null;
  }

  const declaredLength = signature[1]!;
  const expectedLength = declaredLength + 2;
  let der = signature;

  // Some wallets append sighash type to the DER payload.
  if (signature.length === expectedLength + 1) {
    der = signature.slice(0, expectedLength);
  } else if (signature.length !== expectedLength) {
    return null;
  }

  let offset = 2;
  if (der[offset] !== 0x02) {
    return null;
  }
  offset += 1;

  const rLength = der[offset]!;
  offset += 1;
  if (rLength <= 0 || offset + rLength > der.length) {
    return null;
  }
  let r = der.slice(offset, offset + rLength);
  offset += rLength;

  if (der[offset] !== 0x02) {
    return null;
  }
  offset += 1;

  const sLength = der[offset]!;
  offset += 1;
  if (sLength <= 0 || offset + sLength !== der.length) {
    return null;
  }
  let s = der.slice(offset, offset + sLength);

  r = trimLeadingZeros(r);
  s = trimLeadingZeros(s);

  if (r.length > 32 || s.length > 32) {
    return null;
  }

  const compact = new Uint8Array(64);
  compact.set(r, 32 - r.length);
  compact.set(s, 64 - s.length);
  return normalizeCompactSignatureLowS(compact);
}

function decodeSignaturePayload(payload: Uint8Array): Uint8Array | null {
  if (payload.length === 64) {
    return normalizeCompactSignatureLowS(payload);
  }

  if (payload.length === 65) {
    const der = decodeDerSignatureToCompact(payload);
    return der ?? normalizeCompactSignatureLowS(payload.slice(0, 64));
  }

  if (payload.length > 65) {
    const der = decodeDerSignatureToCompact(payload);
    if (der) {
      return der;
    }

    const first = payload[0];
    const second = payload[1];
    if (first >= 1 && first <= 4) {
      if ((second === 65 && payload.length >= 67) || (second === 64 && payload.length >= 66)) {
        return normalizeCompactSignatureLowS(payload.slice(2, 66));
      }
    }

    if (payload.length >= 66) {
      return normalizeCompactSignatureLowS(payload.slice(2, 66));
    }

    return normalizeCompactSignatureLowS(payload.slice(0, 64));
  }

  return null;
}

export function decodeWalletSignature(raw: string): Uint8Array {
  const bytes = decodeRawWalletSignature(raw);

  const witnessItems = parseWitnessStack(bytes);
  if (witnessItems && witnessItems.length > 0) {
    const witnessSignature = decodeSignaturePayload(witnessItems[0]!);
    if (witnessSignature) {
      return witnessSignature;
    }
  }

  const decoded = decodeSignaturePayload(bytes);
  if (decoded) {
    return decoded;
  }

  throw new Error(`Unexpected signature length: ${bytes.length}`);
}
