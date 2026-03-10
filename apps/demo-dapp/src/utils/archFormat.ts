import bs58 from "bs58";

/**
 * Convert a hex string (with optional 0x prefix) to base58.
 * Returns the original string if it doesn't look like valid hex
 * (e.g. already base58, empty, or odd-length).
 */
export function hexToBase58(hex: string): string {
  if (!hex) return hex;
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) return hex;
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) return hex;
  try {
    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleaned.substring(i * 2, i * 2 + 2), 16);
    }
    return bs58.encode(bytes);
  } catch {
    return hex;
  }
}

/**
 * Returns true if a string looks like a hex-encoded value
 * (even length, all hex chars, optionally 0x-prefixed).
 */
export function isHex(s: string): boolean {
  if (!s) return false;
  const cleaned = s.startsWith("0x") ? s.slice(2) : s;
  return cleaned.length > 0 && cleaned.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(cleaned);
}

/**
 * Format an Arch identifier (txid or address) for display.
 * Converts hex to base58; passes through anything that's already base58.
 */
export function formatArchId(id: string | undefined | null): string {
  if (!id) return "";
  return isHex(id) ? hexToBase58(id) : id;
}
