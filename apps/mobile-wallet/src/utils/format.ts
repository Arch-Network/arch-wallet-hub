import bs58 from "bs58";

export function truncateAddress(addr: string, chars = 6): string {
  if (!addr || addr.length <= chars * 2 + 3) return addr || "";
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

export function formatBtc(sats: number): string {
  return `${(sats / 1e8).toFixed(8)} BTC`;
}

export function formatArch(lamports: number | string): string {
  const n = typeof lamports === "string" ? parseInt(lamports, 10) : lamports;
  if (isNaN(n)) return "0 ARCH";
  return `${(n / 1e9).toFixed(4)} ARCH`;
}

export function formatTokenAmount(amount: number, decimals: number): string {
  return (amount / Math.pow(10, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
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

export function formatTimestamp(ts: string | number): string {
  const d = new Date(typeof ts === "number" ? ts * 1000 : ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** UNIX milliseconds for sorting/display; handles Esplora/Titan variants and ms-vs-seconds. */
export function btcTxTimestampMs(tx: unknown): number | null {
  const t = tx as Record<string, unknown> | null;
  if (!t || typeof t !== "object") return null;

  const secondsFrom = (v: unknown): number | null => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
    return v < 1e12 ? v : Math.floor(v / 1000);
  };

  const status = t.status;
  if (status && typeof status === "object") {
    const s = status as Record<string, unknown>;
    const sec = secondsFrom(s.block_time) ?? secondsFrom(s.blockTime);
    if (sec !== null) return sec * 1000;
  }

  const rootSec =
    secondsFrom(t.block_time) ?? secondsFrom(t.blockTime) ?? secondsFrom(t.timestamp);
  if (rootSec !== null) return rootSec * 1000;

  return null;
}
