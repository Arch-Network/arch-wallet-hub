/**
 * Rune amount formatting.
 *
 * Runes carry their raw amount as a u128 decimal string (max value
 * ~3.4e38), which is well outside the safe-integer range of
 * JavaScript `number`. Every arithmetic step must go through `BigInt`;
 * any intermediate `Number(amount)` cast would silently lose precision
 * on large balances and either mis-display or under-protect a user.
 *
 * The `divisibility` field on the rune metadata tells us how many
 * decimal places separate the minor-unit amount from the
 * human-readable display amount. UNCOMMON\u2022GOODS has
 * `divisibility: 0`, so amount "1" displays as "1". A hypothetical
 * 18-decimal rune with amount "1500000000000000000" displays as "1.5".
 */

const MAX_TRAILING_ZERO_TRIM = 38;

export interface FormatRuneAmountOptions {
  /**
   * Maximum fractional digits to render. Defaults to the full
   * divisibility -- callers showing a compact balance row can
   * pass a smaller value (e.g. 4) and the helper will round-half-
   * even via truncation. Trailing zeros are always stripped.
   */
  maxFractionDigits?: number;
}

/**
 * Format a u128 rune amount string as a human-readable decimal.
 *
 * Examples:
 *   formatRuneAmount("100", 0) -> "100"
 *   formatRuneAmount("1500000000000000000", 18) -> "1.5"
 *   formatRuneAmount("123456789", 4) -> "12345.6789"
 *   formatRuneAmount("100000000", 8) -> "1"   (trailing zeros trimmed)
 *   formatRuneAmount("0", 8) -> "0"
 *
 * Returns "0" on parse failure rather than throwing -- the caller
 * is rendering a token row in a wallet UI, not validating input.
 */
export function formatRuneAmount(
  amount: string,
  divisibility: number,
  opts: FormatRuneAmountOptions = {}
): string {
  let raw: bigint;
  try {
    raw = BigInt(amount);
  } catch {
    return "0";
  }
  if (raw < 0n) raw = -raw;

  const div = Math.max(0, Math.floor(divisibility));
  if (div === 0) return raw.toString();

  // Pad-left so split between integer and fractional parts is
  // straightforward for tiny amounts (e.g. "1" with div=8 → "0.00000001").
  const padded = raw.toString().padStart(div + 1, "0");
  const intPart = padded.slice(0, padded.length - div);
  let fracPart = padded.slice(padded.length - div);

  // Truncate to maxFractionDigits if specified; this is round-toward-
  // zero, conservative (a balance shown as "12.34" is always >= 12.34).
  const maxFrac = opts.maxFractionDigits;
  if (typeof maxFrac === "number" && maxFrac >= 0 && fracPart.length > maxFrac) {
    fracPart = fracPart.slice(0, maxFrac);
  }

  // Trim trailing zeros so "1.5000" reads as "1.5". Loop cap is
  // defensive against a misconfigured divisibility (shouldn't fire
  // in practice -- runes are u128 = max ~38 digits).
  let trimmed = fracPart;
  let i = 0;
  while (trimmed.endsWith("0") && i < MAX_TRAILING_ZERO_TRIM) {
    trimmed = trimmed.slice(0, -1);
    i++;
  }

  return trimmed.length === 0 ? intPart : `${intPart}.${trimmed}`;
}

/**
 * Parse a human-entered rune amount string into the minor-unit
 * u128 BigInt the runestone encoder + coin selector expect.
 *
 * Examples (divisibility=8):
 *   parseRuneAmount("1.5", 8)         -> 150_000_000n
 *   parseRuneAmount("1.50000000", 8)  -> 150_000_000n
 *   parseRuneAmount("0.00000001", 8)  -> 1n
 *   parseRuneAmount("100", 0)         -> 100n
 *
 * Returns `null` for invalid / ambiguous input rather than throwing,
 * so a form field can drive validation off this without try/catch:
 *
 *   - Empty string: null (caller treats as "nothing to send yet")
 *   - Non-numeric characters: null
 *   - More fractional digits than `divisibility`: null (would lose
 *     precision; better to reject explicitly than silently truncate)
 *   - Negative: null
 *
 * The CRITICAL invariant: a successful parse always round-trips
 * exactly through formatRuneAmount with the same divisibility.
 */
export function parseRuneAmount(input: string, divisibility: number): bigint | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Whole-number-only fast path; also catches "0".
  if (/^\d+$/.test(trimmed)) {
    const whole = BigInt(trimmed);
    const div = Math.max(0, Math.floor(divisibility));
    return whole * (10n ** BigInt(div));
  }
  // Decimal form: required to look like \d+\.\d+ (no leading dot,
  // no trailing dot, no scientific notation). Reject anything else
  // -- a wallet send page shouldn't be guessing at "1.5e3".
  const m = /^(\d+)\.(\d+)$/.exec(trimmed);
  if (!m) return null;
  const wholePart = m[1]!;
  const fracPart = m[2]!;
  const div = Math.max(0, Math.floor(divisibility));
  if (fracPart.length > div) return null; // would lose precision
  const padded = fracPart.padEnd(div, "0");
  try {
    return BigInt(wholePart) * (10n ** BigInt(div)) + BigInt(padded);
  } catch {
    return null;
  }
}

/**
 * Compact display label that combines symbol + spaced name. The
 * indexer's `symbol` is an optional Unicode glyph; we fall back to
 * the first letter of the spaced_name when missing.
 *
 *   labelForRune({ symbol: "\u29c9", spaced_name: "UNCOMMON\u2022GOODS" })
 *     -> "\u29c9 UNCOMMON\u2022GOODS"
 *   labelForRune({ symbol: undefined, spaced_name: "BITCOIN\u2022RUNES" })
 *     -> "BITCOIN\u2022RUNES"
 */
export function labelForRune(rune: { symbol?: string; spaced_name: string }): string {
  const sym = (rune.symbol ?? "").trim();
  if (sym.length > 0) return `${sym} ${rune.spaced_name}`;
  return rune.spaced_name;
}
