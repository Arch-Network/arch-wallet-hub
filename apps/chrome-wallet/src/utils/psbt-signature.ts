export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export function base64ToHex(base64: string): string {
  return bytesToHex(base64ToBytes(base64));
}

export function extractTapKeySig(psbtBytes: Uint8Array): string {
  // PSBT_IN_TAP_KEY_SIG key type = 0x13; values are 64-byte Schnorr sigs
  // with an optional trailing sighash byte.
  for (let i = 0; i < psbtBytes.length - 67; i += 1) {
    if (psbtBytes[i] === 0x01 && psbtBytes[i + 1] === 0x13) {
      const valueLen = psbtBytes[i + 2];
      if (valueLen === 0x40 || valueLen === 0x41) {
        return bytesToHex(psbtBytes.slice(i + 3, i + 3 + 64));
      }
    }
  }

  for (let i = 0; i < psbtBytes.length - 64; i += 1) {
    if (psbtBytes[i] === 0x40) {
      const sigBytes = psbtBytes.slice(i + 1, i + 1 + 64);
      if (sigBytes.length === 64 && sigBytes.slice(0, 32).some((b) => b !== 0)) {
        return bytesToHex(sigBytes);
      }
    }
  }

  throw new Error("Could not extract Schnorr signature from signed PSBT");
}

export function extractTapKeySigFromPsbtHex(psbtHex: string): string {
  return extractTapKeySig(hexToBytes(psbtHex));
}

export function extractTapKeySigFromPsbtBase64(psbtBase64: string): string {
  return extractTapKeySig(base64ToBytes(psbtBase64));
}
