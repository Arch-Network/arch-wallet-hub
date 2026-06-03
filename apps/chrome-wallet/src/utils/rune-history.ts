/**
 * Helpers for surfacing rune transfer history in the activity feed.
 *
 * The History tab fetches `/bitcoin/address/:a/rune-transactions` and
 * joins it against the BTC tx list by txid so a rune row can show the
 * real rune name, direction, and amount instead of the heuristic
 * "Rune Transfer" label derived from a bare runestone sniff.
 *
 * `delta` from the indexer is a signed decimal string in minor units
 * (positive = inbound to the queried address). Rendering a human
 * amount needs the rune's `divisibility`, which the rune-transactions
 * response omits; callers pass it in from the aggregated balances when
 * known and the formatter degrades to the raw minor-unit integer
 * otherwise (correct for divisibility-0 runes, an over-count for the
 * rest -- still better than hiding the amount).
 */
import type { BtcRuneTransaction } from "./indexer";
import { formatRuneAmount } from "./runes-format";

/**
 * Build a txid -> rune event lookup. The first event per txid wins
 * (the address-level feed lists one entry per affected txid; a defensive
 * de-dupe in case the indexer returns multiple legs).
 */
export function indexRuneTxsByTxid(
  txs: BtcRuneTransaction[]
): Map<string, BtcRuneTransaction> {
  const map = new Map<string, BtcRuneTransaction>();
  for (const t of txs) {
    if (!t || typeof t.txid !== "string" || t.txid.length === 0) continue;
    if (!map.has(t.txid)) map.set(t.txid, t);
  }
  return map;
}

function deltaSign(delta: string): 1 | -1 | 0 {
  try {
    const v = BigInt(delta);
    return v > 0n ? 1 : v < 0n ? -1 : 0;
  } catch {
    return 0;
  }
}

/** Human label for a rune row, e.g. "Received UNCOMMON-GOODS". */
export function runeRowLabel(rt: BtcRuneTransaction): string {
  const name = (rt.spaced_name && rt.spaced_name.trim()) || "Rune";
  switch (rt.kind) {
    case "etch":
      return `Etched ${name}`;
    case "mint":
      return `Minted ${name}`;
    case "burn":
      return `Burned ${name}`;
    case "transfer":
    default: {
      const sign = deltaSign(rt.delta);
      if (sign > 0) return `Received ${name}`;
      if (sign < 0) return `Sent ${name}`;
      return `${name} Transfer`;
    }
  }
}

export interface RuneAmountDisplay {
  direction: "in" | "out" | "neutral";
  amountLabel: string;
}

/**
 * Signed, human-readable rune amount for a row. Returns null when the
 * delta can't be parsed at all (caller then shows no amount).
 */
export function formatRuneDelta(
  delta: string,
  divisibility?: number
): RuneAmountDisplay | null {
  const sign = deltaSign(delta);
  let magnitude: string | null;
  if (typeof divisibility === "number") {
    magnitude = formatRuneAmount(delta, divisibility, { maxFractionDigits: 8 });
  } else {
    magnitude = absMinorUnits(delta);
  }
  if (magnitude == null) return null;
  const direction = sign > 0 ? "in" : sign < 0 ? "out" : "neutral";
  const prefix = sign > 0 ? "+" : sign < 0 ? "-" : "";
  return { direction, amountLabel: `${prefix}${magnitude}` };
}

function absMinorUnits(delta: string): string | null {
  try {
    let v = BigInt(delta);
    if (v < 0n) v = -v;
    return v.toString();
  } catch {
    return null;
  }
}
