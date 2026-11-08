/**
 * Exact, bigint-only formatting for amounts shown on approval screens.
 * Nothing here rounds: an approval must show every unit that moves.
 * Parse dapp-supplied strings with `parseU64DecimalString` first.
 */

export const ARCH_DECIMALS = 9;
export const BTC_DECIMALS = 8;

/** Largest decimals value treated as real token metadata. */
const MAX_DECIMALS = 36;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `amount` base units at `decimals` places, thousands-grouped, trailing zeros trimmed. */
export function formatBaseUnits(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new Error(`Unsupported decimals: ${decimals}`);
  }
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = groupThousands((abs / scale).toString());
  const fraction = decimals === 0 ? "" : (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** BTC string for an integer sat count, or null if `sats` isn't a safe integer. */
export function formatSatsAsBtc(sats: number): string | null {
  return Number.isSafeInteger(sats) ? formatBaseUnits(BigInt(sats), BTC_DECIMALS) : null;
}

export type TokenAmountDisplay =
  | { kind: "scaled"; amount: string; symbol: string }
  | { kind: "raw"; amount: string };

/**
 * Scale a raw token amount by trusted metadata. Without usable metadata
 * the raw amount is returned unscaled so the caller labels it as raw
 * units instead of guessing a decimal point.
 */
export function formatTokenAmountDisplay(
  raw: bigint,
  meta: { decimals: number; symbol: string } | null,
): TokenAmountDisplay {
  if (
    meta &&
    Number.isInteger(meta.decimals) &&
    meta.decimals >= 0 &&
    meta.decimals <= MAX_DECIMALS &&
    meta.symbol.trim() !== ""
  ) {
    return { kind: "scaled", amount: formatBaseUnits(raw, meta.decimals), symbol: meta.symbol };
  }
  return { kind: "raw", amount: formatBaseUnits(raw, 0) };
}

export interface AddressRun {
  text: string;
  strong: boolean;
}

/**
 * Split an address into `size`-character groups for reading aloud and
 * comparing, marking the first and last `emphasize` characters strong.
 * Each group is a list of runs so a group can straddle the boundary.
 */
export function groupAddress(address: string, size = 4, emphasize = 6): AddressRun[][] {
  const chars = [...address];
  const strongAt = (i: number) => i < emphasize || i >= chars.length - emphasize;
  const groups: AddressRun[][] = [];
  for (let start = 0; start < chars.length; start += size) {
    const runs: AddressRun[] = [];
    for (let i = start; i < Math.min(start + size, chars.length); i++) {
      const strong = strongAt(i);
      const last = runs[runs.length - 1];
      if (last && last.strong === strong) last.text += chars[i];
      else runs.push({ text: chars[i]!, strong });
    }
    groups.push(runs);
  }
  return groups;
}
