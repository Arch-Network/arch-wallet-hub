import bs58 from "bs58";

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
  const n = typeof lamports === "string" ? parseInt(lamports, 10) : lamports;
  if (isNaN(n)) return "0 ARCH";
  return `${(n / 1e9).toFixed(4)} ARCH`;
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
