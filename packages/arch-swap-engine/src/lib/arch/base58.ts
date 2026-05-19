const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function hexToBase58(hex: string): string {
  const normalized = hex.trim().toLowerCase();
  const payload = normalized.startsWith("0x") ? normalized.slice(2) : normalized;

  if (!/^[0-9a-f]+$/.test(payload) || payload.length % 2 !== 0) {
    throw new Error("Invalid hex payload.");
  }
  if (payload.length !== 64) {
    throw new Error("Expected 32-byte hex payload.");
  }

  const bytes: number[] = [];
  for (let index = 0; index < payload.length; index += 2) {
    bytes.push(Number.parseInt(payload.slice(index, index + 2), 16));
  }

  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    leadingZeros += 1;
  }

  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let output = "1".repeat(leadingZeros);
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    output += ALPHABET[digits[index]];
  }

  return output;
}

export function base58ToHex(b58: string): string {
  const bytes = new Array(32).fill(0);
  for (const char of b58) {
    const carry = ALPHABET.indexOf(char);
    if (carry < 0) throw new Error("Invalid base58 character.");
    let c = carry;
    for (let j = bytes.length - 1; j >= 0; j--) {
      c += 58 * bytes[j];
      bytes[j] = c & 0xff;
      c >>= 8;
    }
  }
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isHex(value: string): boolean {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  return /^[0-9a-fA-F]+$/.test(normalized) && normalized.length % 2 === 0;
}

/**
 * Validates that a string is a valid base58-encoded 32-byte address.
 * Returns the decoded hex string if valid, or null if invalid.
 */
export function validateBase58Address(b58: string): string | null {
  if (!b58 || b58.length < 32 || b58.length > 44) return null;
  try {
    const hex = base58ToHex(b58);
    if (hex.length !== 64) return null;
    return hex;
  } catch {
    return null;
  }
}
