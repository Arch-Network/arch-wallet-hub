export const U64_MAX = 2n ** 64n - 1n;

/**
 * Strict reader for dapp-supplied u64 amounts (ARCH lamports, APL raw
 * token units). The Hub parses these with `BigInt()`, which also accepts
 * hex/binary/octal prefixes and surrounding whitespace, so anything but
 * plain decimal digits could be displayed as one amount and signed as
 * another.
 */
export function parseU64DecimalString(raw: unknown): bigint | null {
  if (typeof raw !== "string" || !/^[0-9]{1,20}$/.test(raw)) return null;
  const value = BigInt(raw);
  return value <= U64_MAX ? value : null;
}
