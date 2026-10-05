/**
 * What the home screen's headline says about an account's holdings.
 * Distinguishes test assets, empty, unavailable, and partially valued
 * holdings, so an unknown balance or a missing price is never shown as
 * a zero, and test coins are never given a dollar value.
 */
import type { NetworkId } from "../state/types";
import type { PortfolioValuation } from "./prices";
import { formatBtc, formatUsd } from "./format";

export interface HoldingsSnapshot {
  network: NetworkId;
  /** Confirmed + pending sats over readable addresses; null when none could be read. */
  btcSats: number | null;
  /** Some, but not all, of the account's Bitcoin addresses couldn't be read. */
  btcPartial: boolean;
  /** Null when the Arch account couldn't be read. */
  archLamports: number | null;
  tokenCount: number;
}

export type PortfolioTone = "value" | "test" | "empty" | "unavailable";

export interface PortfolioHeadline {
  tone: PortfolioTone;
  primary: string;
  secondary: string;
  /** Short caveats shown under the headline, most important first. */
  notes: string[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function unpricedNote(snapshot: HoldingsSnapshot, valuation: PortfolioValuation): string | null {
  const parts: string[] = [];
  if ((snapshot.archLamports ?? 0) > 0 && !valuation.archPriced) parts.push("ARCH");
  const unpricedTokens = Object.values(valuation.tokenBreakdown).filter((t) => t.unpriced).length;
  if (unpricedTokens > 0) parts.push(plural(unpricedTokens, "token"));
  return parts.length ? `Excludes ${parts.join(" and ")} with no price` : null;
}

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function describePortfolio(
  snapshot: HoldingsSnapshot,
  valuation: PortfolioValuation | null,
): PortfolioHeadline {
  const { btcSats, archLamports } = snapshot;
  if (btcSats === null && archLamports === null) {
    return {
      tone: "unavailable",
      primary: "Balances unavailable",
      secondary: "Couldn't reach the indexer",
      notes: [],
    };
  }

  const notes: string[] = [];
  if (btcSats === null) notes.push("Bitcoin balance couldn't be loaded");
  else if (snapshot.btcPartial) notes.push("Some Bitcoin addresses couldn't be loaded");
  if (archLamports === null) notes.push("ARCH balance couldn't be loaded");

  const isEmpty = (btcSats ?? 0) === 0 && (archLamports ?? 0) === 0 && snapshot.tokenCount === 0;
  if (isEmpty && notes.length === 0) {
    return { tone: "empty", primary: formatBtc(0), secondary: "No assets yet", notes };
  }

  if (snapshot.network !== "mainnet") {
    return {
      tone: "test",
      primary: btcSats === null ? "—" : formatBtc(btcSats),
      secondary: "Test assets · no monetary value",
      notes,
    };
  }

  if (!valuation || ((btcSats ?? 0) > 0 && !valuation.btcPriced)) {
    return {
      tone: "value",
      primary: btcSats === null ? "—" : formatBtc(btcSats),
      secondary: "USD price unavailable",
      notes,
    };
  }

  const unpriced = unpricedNote(snapshot, valuation);
  if (unpriced) notes.push(unpriced);
  if (valuation.stale && valuation.pricedAt !== null) notes.push(`Prices from ${timeOf(valuation.pricedAt)}`);
  return {
    tone: "value",
    primary: formatUsd(valuation.totalUsd),
    secondary: notes.length ? "Partial value" : "Portfolio value",
    notes,
  };
}
