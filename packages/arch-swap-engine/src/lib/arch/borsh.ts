// Borsh-compatible little-endian integer encoders/decoders plus the few
// other primitive readers (bool, pubkey) every account-state deserializer
// needs. Pure functions, no I/O.

export function encodeU16LE(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

export function encodeU64LE(value: bigint): number[] {
  const bytes: number[] = [];
  let v = value;
  for (let i = 0; i < 8; i++) {
    bytes.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return bytes;
}

export function encodeU128LE(value: bigint): number[] {
  const bytes: number[] = [];
  let v = value;
  for (let i = 0; i < 16; i++) {
    bytes.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return bytes;
}

export function encodeI32LE(value: number): number[] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setInt32(0, value, true);
  return Array.from(new Uint8Array(buf));
}

export function encodeI128LE(value: bigint): number[] {
  // Two's complement for 128-bit signed integer
  const mask = (1n << 128n) - 1n;
  const unsigned = value < 0n ? (mask + value + 1n) & mask : value & mask;
  return encodeU128LE(unsigned);
}

export function decodeU64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(data[offset + i]) << (BigInt(i) * 8n);
  }
  return value;
}

export function decodeU128LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 16; i++) {
    value |= BigInt(data[offset + i]) << (BigInt(i) * 8n);
  }
  return value;
}

export function decodeI32LE(data: Uint8Array, offset: number): number {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  for (let i = 0; i < 4; i++) {
    view.setUint8(i, data[offset + i]);
  }
  return view.getInt32(0, true);
}

export function decodeI128LE(data: Uint8Array, offset: number): bigint {
  const unsigned = decodeU128LE(data, offset);
  const signBit = 1n << 127n;
  if (unsigned & signBit) {
    return unsigned - (1n << 128n);
  }
  return unsigned;
}

export function decodeBool(data: Uint8Array, offset: number): boolean {
  return data[offset] !== 0;
}

export function decodePubkey(data: Uint8Array, offset: number): Uint8Array {
  return data.slice(offset, offset + 32);
}
