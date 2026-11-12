import bs58 from "bs58";
import { parseU64DecimalString, U64_MAX } from "./u64-amount";

export function truncateAddress(addr: string, chars = 6): string {
  if (!addr || addr.length <= chars * 2 + 3) return addr || "";
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

export function formatBtc(sats: number): string {
  return `${(sats / 1e8).toFixed(8)} BTC`;
}

/** Just the numeric portion, e.g. "0.00000000". Used in places that show
 *  the unit separately (asset rows already render "BTC" in the sub line). */
export function formatBtcAmount(sats: number): string {
  return (sats / 1e8).toFixed(8);
}

export function formatArch(lamports: number | string): string {
  const n =
    typeof lamports === "string"
      ? parseU64DecimalString(lamports)
      : Number.isInteger(lamports) && lamports >= 0 && BigInt(lamports) <= U64_MAX
        ? BigInt(lamports)
        : null;
  if (n === null) return "Invalid amount";
  const tenThousandths = (n + 50_000n) / 100_000n;
  return `${tenThousandths / 10_000n}.${(tenThousandths % 10_000n).toString().padStart(4, "0")} ARCH`;
}

/** Just the numeric portion, e.g. "0.0010". Counterpart to formatBtcAmount. */
export function formatArchAmount(lamports: number | string): string {
  const n = typeof lamports === "string" ? parseInt(lamports, 10) : lamports;
  if (isNaN(n)) return "0";
  return (n / 1e9).toFixed(4);
}

export function formatTokenAmount(amount: number, decimals: number): string {
  return (amount / Math.pow(10, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

/** How the Swap surface shows amounts of one token. */
export type SwapPrecision = {
  /** Decimal places on the cards, where amounts are read at a glance. */
  display: number;
  /** Every place the token can carry, for the figures a swap is reviewed on. */
  full: number;
};

/** Cards stop at 8 places: enough for a satoshi, and it keeps the row on one line. */
const SWAP_CARD_MAX_DECIMALS = 8;

/**
 * Precision for a token from its own metadata, never from its symbol:
 * the wallet renames tokens for display (USDC shows as "aUSD"), so a
 * symbol check silently stops matching. Dollar-pegged tokens read as
 * money; everything else shows the precision it has on chain.
 */
export function swapPrecision(tokenDecimals: number, dollarPegged: boolean): SwapPrecision {
  const full = Number.isInteger(tokenDecimals) && tokenDecimals > 0 ? tokenDecimals : 0;
  return {
    display: Math.min(full, dollarPegged ? 2 : SWAP_CARD_MAX_DECIMALS),
    full,
  };
}

/**
 * Render an already-scaled token amount (display units, not atomic)
 * with locale-aware thousands separators. Shows `decimals` places, and
 * up to `maxDecimals` when the amount has them. A positive amount too
 * small to show reads "<0.01" rather than rounding to a zero the user
 * would take for nothing. Returns "0" for zero / non-finite so the
 * caller can decide whether to append the symbol.
 *
 * Examples:
 *   formatSwapAmount(99696,   2)     → "99,696.00"
 *   formatSwapAmount(1.0039,  8)     → "1.00390000"
 *   formatSwapAmount(0.004,   2)     → "<0.01"
 *   formatSwapAmount(0.004,   2, 6)  → "0.004"
 *   formatSwapAmount(0,       2)     → "0"
 */
export function formatSwapAmount(amount: number, decimals: number, maxDecimals = decimals): string {
  if (!Number.isFinite(amount) || amount <= 0) return "0";
  const max = Math.max(decimals, maxDecimals);
  const smallest = 10 ** -max;
  if (amount < smallest) {
    return `<${smallest.toLocaleString(undefined, {
      minimumFractionDigits: max,
      maximumFractionDigits: max,
    })}`;
  }
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: max,
  });
}

/**
 * Same precision as `formatSwapAmount`, but always appends the symbol.
 * Used by the Swap cards' "Bal X" indicator so the unit is never
 * lost.
 */
export function formatSwapBalance(
  balance: number,
  symbol: string,
  decimals: number,
  maxDecimals = decimals,
): string {
  return `${formatSwapAmount(balance, decimals, maxDecimals)} ${symbol}`;
}

/**
 * A swap rate ("1 aBTC ≈ … aUSD") as a number. Rates of 100 and up read
 * as prices; below 1 the leading zeros carry no information, so the
 * rate keeps six significant digits instead of six decimal places —
 * a dollar-to-bitcoin rate is 0.0000139171, not "0.000014".
 */
export function formatSwapRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "—";
  if (rate < 1) return rate.toLocaleString(undefined, { maximumSignificantDigits: 6 });
  const decimals = rate >= 100 ? 2 : 6;
  return rate.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * A balance as text for an amount field: every place the token has and
 * no more, so "MAX" spends the whole balance without rounding past it.
 *
 *   formatMaxAmount(10.999999, 6) → "10.999999"
 *   formatMaxAmount(0.5,       8) → "0.5"
 */
export function formatMaxAmount(balance: number, tokenDecimals: number): string {
  if (!Number.isFinite(balance) || balance <= 0) return "";
  const fixed = balance.toFixed(Math.min(Math.max(tokenDecimals, 0), 20));
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Format a USD amount with smart precision: < $1 -> 4 decimals, otherwise 2. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  const abs = Math.abs(value);
  const digits = abs > 0 && abs < 1 ? 4 : 2;
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Convert sats + BTC-USD price into a formatted USD string, or null if price is missing. */
export function formatBtcUsd(sats: number, btcUsd: number | null | undefined): string | null {
  if (btcUsd == null || !Number.isFinite(btcUsd) || btcUsd <= 0) return null;
  const usd = (sats / 1e8) * btcUsd;
  return formatUsd(usd);
}

export function hexToBase58(hex: string): string {
  try {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return bs58.encode(bytes);
  } catch {
    return hex;
  }
}

export function isHex(str: string): boolean {
  return /^(0x)?[0-9a-fA-F]+$/.test(str);
}

export function formatArchId(id: string): string {
  if (!id) return "";
  if (isHex(id) && id.length >= 32) return hexToBase58(id);
  return id;
}

export function timestampToMs(ts: string | number | null | undefined): number | null {
  if (ts == null || ts === "") return null;

  if (typeof ts === "number") {
    if (!Number.isFinite(ts) || ts <= 0) return null;
    return ts < 1e12 ? ts * 1000 : ts;
  }

  const trimmed = ts.trim();
  if (!trimmed) return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }

  const parsed = new Date(trimmed).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function formatTimestamp(ts: string | number): string {
  const ms = timestampToMs(ts);
  if (ms == null) return String(ts);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** UNIX milliseconds for sorting/display; handles Esplora/Indexer variants and ms-vs-seconds. */
export function btcTxTimestampMs(tx: unknown): number | null {
  const t = tx as Record<string, unknown> | null;
  if (!t || typeof t !== "object") return null;

  const msFrom = (v: unknown): number | null => {
    if (typeof v === "number" || typeof v === "string") return timestampToMs(v);
    return null;
  };

  const status = t.status;
  if (status && typeof status === "object") {
    const s = status as Record<string, unknown>;
    const ms =
      msFrom(s.block_time) ??
      msFrom(s.blockTime) ??
      msFrom(s.block_timestamp) ??
      msFrom(s.blockTimestamp) ??
      msFrom(s.timestamp) ??
      msFrom(s.time);
    if (ms !== null) return ms;
  }

  return (
    msFrom(t.block_time) ??
    msFrom(t.blockTime) ??
    msFrom(t.block_timestamp) ??
    msFrom(t.blockTimestamp) ??
    msFrom(t.timestamp) ??
    msFrom(t.time) ??
    msFrom(t.confirmed_at) ??
    msFrom(t.confirmedAt) ??
    msFrom(t.first_seen_at) ??
    msFrom(t.firstSeenAt) ??
    msFrom(t.seen_at) ??
    msFrom(t.seenAt) ??
    msFrom(t.received_at) ??
    msFrom(t.receivedAt) ??
    msFrom(t.created_at) ??
    msFrom(t.createdAt) ??
    null
  );
}
