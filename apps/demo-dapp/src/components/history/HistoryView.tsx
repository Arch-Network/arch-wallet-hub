import { useState, useEffect, useCallback } from "react";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import type { ArchNetwork, BtcTransaction } from "@arch/wallet-hub-sdk";
import type { ConnectedWallet } from "../../types";
import CopyButton from "../shared/CopyButton";
import { formatArchId } from "../../utils/archFormat";
import bs58 from "bs58";

// ── Unified transaction model ──

type TxType = "arch" | "btc";
type TxStatus = "success" | "failed" | "pending" | "confirmed" | "unconfirmed";

type TxDirection = "send" | "receive" | "self" | "unknown";

type UnifiedTx = {
  id: string;
  rawId: string;
  type: TxType;
  status: TxStatus;
  direction: TxDirection;
  timestamp: number;
  timestampLabel: string;
  fee: string | null;
  from: string | null;
  to: string | null;
  amount: string | null;
  amountRaw: number | null;
  amountUnit: string | null;
  blockHeight: number | null;
  instructions: string[];
  raw: unknown;
};

type Props = {
  client: WalletHubClient;
  wallet: ConnectedWallet;
  network: ArchNetwork;
  externalUserId: string;
};

type FilterType = "all" | "arch" | "btc";

// ── Helpers ──

function archExplorerUrl(txid: string, network: ArchNetwork): string {
  return `https://explorer.arch.network/${network}/tx/${txid}`;
}

function btcExplorerUrl(txid: string, network: ArchNetwork): string {
  const host = network === "testnet" ? "mempool.space/testnet4" : "mempool.space";
  return `https://${host}/tx/${txid}`;
}

function truncateId(s: string | undefined | null): string {
  if (!s) return "—";
  if (s.length <= 16) return s;
  return `${s.slice(0, 10)}...${s.slice(-6)}`;
}

function formatTimestamp(ts: number): string {
  if (!ts || isNaN(ts)) return "—";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();

  if (isYesterday) {
    return `Yesterday, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }

  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatSats(sats: number): string {
  if (sats >= 100_000_000) return `${(sats / 100_000_000).toFixed(8)} BTC`;
  return `${sats.toLocaleString()} sats`;
}

// ── Timestamp resolution ──

function parseDate(v: unknown): number {
  if (!v) return 0;
  if (typeof v === "number") {
    // If the value is small enough to be UNIX seconds, convert to ms
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === "string") {
    const ms = new Date(v).getTime();
    return isNaN(ms) ? 0 : ms;
  }
  return 0;
}

/**
 * Resolve the best timestamp for an Arch transaction.
 * `confirmed_at` = real on-chain confirmation time (preferred).
 * `created_at`   = Indexer insertion time (unreliable after backfills).
 * Also checks `block_time` and `timestamp` for additional sources.
 */
function resolveArchTimestamp(tx: Record<string, unknown>): number {
  const confirmedAt = parseDate(tx.confirmed_at);
  if (confirmedAt > 0) return confirmedAt;

  const blockTime = parseDate(tx.block_time ?? tx.blockTime);
  if (blockTime > 0) return blockTime;

  const timestamp = parseDate(tx.timestamp);
  if (timestamp > 0) return timestamp;

  const createdAt = parseDate(tx.created_at);
  if (createdAt > 0) return createdAt;

  return 0;
}

// ── Arch instruction decoding ──

function formatLamports(lamports: number): string {
  if (lamports >= 1_000_000_000) return `${(lamports / 1_000_000_000).toFixed(6)} ARCH`;
  return `${lamports.toLocaleString()} lamports`;
}

/**
 * Extract transfer info from an Arch transaction detail response.
 * Returns { from, to, lamports } if it's a system transfer, null otherwise.
 */
function extractArchTransferInfo(
  detail: Record<string, unknown>,
): { from: string; to: string; lamports: number } | null {
  const data = detail.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const msg = data.message as Record<string, unknown> | undefined;
  if (!msg) return null;

  const accountKeys = msg.account_keys as number[][] | undefined;
  const instructions = msg.instructions as Array<{
    accounts?: number[];
    data?: number[];
    program_id_index?: number;
  }> | undefined;

  if (!accountKeys || !instructions || instructions.length === 0) return null;

  for (const ix of instructions) {
    const ixData = ix.data;
    if (!ixData || ixData.length < 12) continue;

    // Transfer discriminant = 5 (little-endian u32)
    const disc = ixData[0] | (ixData[1] << 8) | (ixData[2] << 16) | (ixData[3] << 24);
    if (disc !== 5) continue;

    // Lamports: u64 little-endian (read lower 32 bits + upper 32 bits)
    const lo = (ixData[4] | (ixData[5] << 8) | (ixData[6] << 16) | ((ixData[7] << 24) >>> 0)) >>> 0;
    const hi = (ixData[8] | (ixData[9] << 8) | (ixData[10] << 16) | ((ixData[11] << 24) >>> 0)) >>> 0;
    const lamports = lo + hi * 0x100000000;

    const accs = ix.accounts ?? [];
    const fromKey = accs[0] !== undefined ? accountKeys[accs[0]] : undefined;
    const toKey = accs[1] !== undefined ? accountKeys[accs[1]] : undefined;

    if (!fromKey || !toKey) continue;

    return {
      from: bs58.encode(new Uint8Array(fromKey)),
      to: bs58.encode(new Uint8Array(toKey)),
      lamports,
    };
  }

  return null;
}

// ── Normalization ──

function resolveArchStatus(tx: Record<string, unknown>): TxStatus {
  // 1. Check status.type (Indexer detail response: { type: "processed"|"failed", message? })
  const s = tx.status as Record<string, unknown> | undefined;
  if (s && typeof s === "object") {
    const sType = String(s.type ?? "").toLowerCase();
    if (sType === "failed") return "failed";
    if (sType === "processed" || sType === "success") return "success";
  }

  // 2. Explicit success boolean
  if (tx.success === true || (tx.success as any) === "true") return "success";
  if (tx.success === false || (tx.success as any) === "false") return "failed";

  // 3. If included in a block but no status detail yet, mark as "confirmed" (unknown outcome)
  if (tx.height !== undefined || tx.block_height !== undefined) return "confirmed";

  return "pending";
}

function normalizeArchTx(tx: Record<string, unknown>): UnifiedTx {
  const rawTxid = (tx.txid || tx.tx_id || tx.id || "") as string;
  const status = resolveArchStatus(tx);

  const ts = resolveArchTimestamp(tx);

  const transfer = tx.token_transfer as { amount?: string; mint?: string } | null | undefined;

  const rawFrom = (tx.from_address as string) || null;
  const rawTo = (tx.to_address as string) || null;

  return {
    id: formatArchId(rawTxid),
    rawId: rawTxid,
    type: "arch",
    direction: "unknown",
    status,
    timestamp: ts,
    timestampLabel: ts ? formatTimestamp(ts) : "—",
    fee: tx.fee ? `${tx.fee} lamports` : tx.fee_estimated_arch ? `~${tx.fee_estimated_arch} ARCH` : null,
    from: rawFrom ? formatArchId(rawFrom) : null,
    to: rawTo ? formatArchId(rawTo) : null,
    amount: transfer?.amount ? `${transfer.amount}` : null,
    amountRaw: null,
    amountUnit: null,
    blockHeight: (tx.height ?? tx.block_height ?? null) as number | null,
    instructions: (tx.instructions as string[]) || [],
    raw: tx,
  };
}

function normalizeBtcTx(raw: BtcTransaction, walletAddress: string): UnifiedTx {
  const tx = (raw ?? {}) as any;
  const txid: string = tx.txid || tx.tx_id || tx.id || "";

  const confirmed = tx.status?.confirmed === true;
  const status: TxStatus = confirmed ? "confirmed" : "unconfirmed";
  const ts = tx.status?.block_time ? tx.status.block_time * 1000 : 0;

  let sentSats = 0;
  let receivedSats = 0;
  const vin = Array.isArray(tx.vin) ? tx.vin : [];
  const vout = Array.isArray(tx.vout) ? tx.vout : [];

  for (const inp of vin) {
    if (inp.prevout?.scriptpubkey_address === walletAddress) {
      sentSats += inp.prevout.value ?? 0;
    }
  }
  for (const out of vout) {
    if (out.scriptpubkey_address === walletAddress) {
      receivedSats += out.value ?? 0;
    }
  }

  const net = receivedSats - sentSats;
  const isSend = net < 0;
  const isSelf = sentSats > 0 && receivedSats > 0 && net === 0;
  const absAmount = Math.abs(net);
  const direction: TxDirection = isSelf ? "self" : isSend ? "send" : receivedSats > 0 ? "receive" : "unknown";

  const firstInputAddr = vin[0]?.prevout?.scriptpubkey_address || null;
  const firstOutputAddr = vout.find((o: any) => o.scriptpubkey_address !== walletAddress)?.scriptpubkey_address || vout[0]?.scriptpubkey_address || null;

  return {
    id: txid,
    rawId: txid,
    type: "btc",
    direction,
    status,
    timestamp: ts,
    timestampLabel: ts ? formatTimestamp(ts) : "—",
    fee: tx.fee != null ? `${Number(tx.fee).toLocaleString()} sats` : null,
    from: isSend ? walletAddress : firstInputAddr,
    to: isSend ? firstOutputAddr : walletAddress,
    amount: absAmount > 0 ? `${isSend ? "-" : "+"}${formatSats(absAmount)}` : null,
    amountRaw: absAmount,
    amountUnit: "sats",
    blockHeight: tx.status?.block_height ?? null,
    instructions: [],
    raw,
  };
}

/**
 * The BTC address/txs endpoint may return full tx objects OR just txid strings.
 * When strings are returned, fetch full details for each in parallel.
 */
async function resolveBtcTxs(
  client: WalletHubClient,
  items: unknown[]
): Promise<BtcTransaction[]> {
  if (items.length === 0) return [];

  if (typeof items[0] === "object" && items[0] !== null && "txid" in items[0]) {
    return items as BtcTransaction[];
  }

  const results = await Promise.allSettled(
    items.map((item) => {
      const txid = typeof item === "string" ? item : (item as any)?.txid ?? "";
      if (!txid) return Promise.resolve(null);
      return client.getBtcTransaction(txid);
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<BtcTransaction> =>
      r.status === "fulfilled" && r.value != null
    )
    .map((r) => r.value);
}

type ArchEnrichment = {
  status?: TxStatus;
  direction?: TxDirection;
  from?: string;
  to?: string;
  amount?: string;
  amountRaw?: number;
  amountUnit?: string;
};

/**
 * Fetch individual tx details in parallel to resolve real status,
 * direction, and transfer amounts for Arch transactions.
 */
function enrichArchDetails(
  client: WalletHubClient,
  txs: UnifiedTx[],
  walletArchAddress: string,
  setter: React.Dispatch<React.SetStateAction<UnifiedTx[]>>
) {
  Promise.allSettled(
    txs.map((t) => client.getTransactionDetail(t.rawId))
  ).then((results) => {
    const enrichMap = new Map<string, ArchEnrichment>();
    results.forEach((r, i) => {
      if (r.status !== "fulfilled" || !r.value) return;
      const detail = r.value as Record<string, unknown>;
      const enrichment: ArchEnrichment = {};

      const resolved = resolveArchStatus(detail);
      if (resolved !== "confirmed" && resolved !== "pending") {
        enrichment.status = resolved;
      }

      const transfer = extractArchTransferInfo(detail);
      if (transfer) {
        const fromMatch = transfer.from === walletArchAddress;
        const toMatch = transfer.to === walletArchAddress;
        enrichment.direction = fromMatch && toMatch ? "self" : fromMatch ? "send" : toMatch ? "receive" : "unknown";
        enrichment.from = formatArchId(transfer.from);
        enrichment.to = formatArchId(transfer.to);
        enrichment.amountRaw = transfer.lamports;
        enrichment.amountUnit = "lamports";

        const prefix = enrichment.direction === "send" ? "-" : enrichment.direction === "receive" ? "+" : "";
        enrichment.amount = `${prefix}${formatLamports(transfer.lamports)}`;
      }

      if (Object.keys(enrichment).length > 0) {
        enrichMap.set(txs[i].rawId, enrichment);
      }
    });
    if (enrichMap.size > 0) {
      setter((prev) =>
        prev.map((t) => {
          const e = enrichMap.get(t.rawId);
          if (!e) return t;
          return {
            ...t,
            ...(e.status && { status: e.status }),
            ...(e.direction && { direction: e.direction }),
            ...(e.from && { from: e.from }),
            ...(e.to && { to: e.to }),
            ...(e.amount && { amount: e.amount }),
            ...(e.amountRaw !== undefined && { amountRaw: e.amountRaw }),
            ...(e.amountUnit && { amountUnit: e.amountUnit }),
          };
        })
      );
    }
  });
}

// ── Component ──

export default function HistoryView({ client, wallet, network }: Props) {
  const [archTxs, setArchTxs] = useState<UnifiedTx[]>([]);
  const [btcTxs, setBtcTxs] = useState<UnifiedTx[]>([]);
  const [archLoading, setArchLoading] = useState(true);
  const [btcLoading, setBtcLoading] = useState(true);
  const [archError, setArchError] = useState("");
  const [btcError, setBtcError] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const [expandedTx, setExpandedTx] = useState<string | null>(null);
  const [txDetails, setTxDetails] = useState<Record<string, any>>({});

  const [archPage, setArchPage] = useState(1);
  const [archHasMore, setArchHasMore] = useState(false);
  const [btcLastTxid, setBtcLastTxid] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const archAddress = wallet.archAddress || wallet.address;
  const btcAddress = wallet.address;

  const fetchInitial = useCallback(async () => {
    setArchLoading(true);
    setBtcLoading(true);
    setArchError("");
    setBtcError("");

    const [archResult, btcResult] = await Promise.allSettled([
      client.getTransactionHistory(archAddress, { limit: 25 }),
      client.getBtcTransactions(btcAddress),
    ]);

    if (archResult.status === "fulfilled") {
      const res = archResult.value as any;
      const txs = (res.transactions ?? []) as Record<string, unknown>[];
      const initial = txs.map(normalizeArchTx);
      setArchTxs(initial);
      setArchPage(1);
      const pageLimit = res.limit ?? 25;
      setArchHasMore(txs.length >= pageLimit);

      // Enrich all Arch txs: the list endpoint lacks status.type, amounts, and direction.
      if (initial.length > 0) {
        enrichArchDetails(client, initial, archAddress, setArchTxs);
      }
    } else {
      const msg = archResult.reason?.message || "Failed to load Arch transactions";
      const isTimeout = /timeout|UpstreamTimeout|504/i.test(msg);
      setArchError(isTimeout
        ? "Transaction history is temporarily unavailable (upstream timeout)."
        : `Arch: ${msg}`);
    }
    setArchLoading(false);

    if (btcResult.status === "fulfilled") {
      const raw = btcResult.value ?? [];
      const arr = Array.isArray(raw) ? raw : [];
      const resolved = await resolveBtcTxs(client, arr);
      const normalized = resolved.map((t) => normalizeBtcTx(t, btcAddress));
      setBtcTxs(normalized);
      // Only enable "load more" if we got a full page (25+ results)
      if (resolved.length >= 25) {
        const last = resolved[resolved.length - 1];
        setBtcLastTxid(last?.txid ?? null);
      } else {
        setBtcLastTxid(null);
      }
    } else {
      setBtcError(btcResult.reason?.message || "Failed to load Bitcoin transactions");
    }
    setBtcLoading(false);
  }, [client, archAddress, btcAddress]);

  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  const loadMoreArch = useCallback(async () => {
    if (!archHasMore) return;
    setLoadingMore(true);
    try {
      const nextPage = archPage + 1;
      const res = await client.getTransactionHistory(archAddress, { limit: 25, page: nextPage }) as any;
      const txs = (res.transactions ?? []) as Record<string, unknown>[];
      const normalized = txs.map(normalizeArchTx);
      setArchTxs((prev) => [...prev, ...normalized]);
      setArchPage(nextPage);
      const pageLimit = res.limit ?? 25;
      setArchHasMore(txs.length >= pageLimit);
      if (normalized.length > 0) {
        enrichArchDetails(client, normalized, archAddress, setArchTxs);
      }
    } catch (e: any) {
      setArchError(e?.message || "Failed to load more");
    }
    setLoadingMore(false);
  }, [client, archAddress, archPage, archHasMore]);

  const loadMoreBtc = useCallback(async () => {
    if (!btcLastTxid) return;
    setLoadingMore(true);
    try {
      const raw = await client.getBtcTransactions(btcAddress, btcLastTxid);
      const arr = Array.isArray(raw) ? raw : [];
      const resolved = await resolveBtcTxs(client, arr);
      if (resolved.length === 0) {
        setBtcLastTxid(null);
      } else {
        const normalized = resolved.map((t) => normalizeBtcTx(t, btcAddress));
        setBtcTxs((prev) => {
          const seen = new Set(prev.map((t) => t.rawId));
          const fresh = normalized.filter((t) => !seen.has(t.rawId));
          if (fresh.length === 0) {
            setBtcLastTxid(null);
            return prev;
          }
          return [...prev, ...fresh];
        });
        if (resolved.length >= 25) {
          const last = resolved[resolved.length - 1];
          setBtcLastTxid(last?.txid ?? null);
        } else {
          setBtcLastTxid(null);
        }
      }
    } catch (e: any) {
      setBtcError(e?.message || "Failed to load more");
    }
    setLoadingMore(false);
  }, [client, btcAddress, btcLastTxid]);

  const handleLoadMore = useCallback(() => {
    if (filter === "arch") return loadMoreArch();
    if (filter === "btc") return loadMoreBtc();
    return Promise.all([
      archHasMore ? loadMoreArch() : Promise.resolve(),
      btcLastTxid ? loadMoreBtc() : Promise.resolve(),
    ]);
  }, [filter, loadMoreArch, loadMoreBtc, archHasMore, btcLastTxid]);

  const toggleExpand = useCallback(
    async (tx: UnifiedTx) => {
      const key = `${tx.type}-${tx.rawId}`;
      if (expandedTx === key) {
        setExpandedTx(null);
        return;
      }
      setExpandedTx(key);
      if (tx.type === "arch" && !txDetails[key]) {
        try {
          const detail = await client.getTransactionDetail(tx.rawId);
          setTxDetails((prev) => ({ ...prev, [key]: detail }));
        } catch {
          /* detail unavailable */
        }
      }
    },
    [expandedTx, txDetails, client]
  );

  // ── Merge + filter + sort ──

  const allTxs = [...archTxs, ...btcTxs];
  const filtered = filter === "all" ? allTxs : allTxs.filter((t) => t.type === filter);
  filtered.sort((a, b) => b.timestamp - a.timestamp);

  const archCount = allTxs.filter((t) => t.type === "arch").length;
  const btcCount = allTxs.filter((t) => t.type === "btc").length;
  const isLoading = archLoading && btcLoading;
  const hasMore =
    filter === "all" ? !!(archHasMore || btcLastTxid) :
    filter === "arch" ? archHasMore :
    !!btcLastTxid;

  // ── Render ──

  return (
    <div className="history-view">
      <div className="history-header">
        <h1 className="history-title">Transaction History</h1>
        <span className="history-count">{filtered.length} shown</span>
      </div>

      <div className="history-filter-bar">
        {(["all", "arch", "btc"] as FilterType[]).map((f) => {
          const count = f === "all" ? archCount + btcCount : f === "arch" ? archCount : btcCount;
          const loading = f === "arch" ? archLoading : f === "btc" ? btcLoading : archLoading || btcLoading;
          return (
            <button
              key={f}
              className={`filter-pill${filter === f ? " active" : ""}`}
              onClick={() => setFilter(f)}
              type="button"
            >
              {f === "all" ? "All" : f === "arch" ? "Arch" : "Bitcoin"}
              <span className="filter-pill-count">
                {loading ? "..." : count}
              </span>
            </button>
          );
        })}
      </div>

      {(archError || btcError) && (
        <div className="history-errors">
          {archError && <p className="history-error-msg">Arch: {archError}</p>}
          {btcError && <p className="history-error-msg">Bitcoin: {btcError}</p>}
        </div>
      )}

      {isLoading ? (
        <div className="history-skeleton">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="tx-skeleton-row" style={{ animationDelay: `${i * 0.1}s` }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="history-empty">
          <span className="history-empty-icon">
            {filter === "btc" ? "₿" : filter === "arch" ? "⬡" : "📭"}
          </span>
          <p>No {filter === "all" ? "" : `${filter} `}transactions found</p>
        </div>
      ) : (
        <div className="history-table">
          {filtered.map((tx) => {
            const txKey = `${tx.type}-${tx.rawId}`;
            const expanded = expandedTx === txKey;
            const detail = txDetails[txKey];
            return (
              <div key={txKey} className={`history-tx-card${expanded ? " expanded" : ""}`}>
                <button
                  className="history-tx-main"
                  onClick={() => toggleExpand(tx)}
                  type="button"
                >
                  <div className="tx-direction-icon-wrap">
                    <span className={`tx-direction-icon ${tx.direction}`}>
                      {tx.direction === "send" ? "↑" : tx.direction === "receive" ? "↓" : tx.direction === "self" ? "↻" : "•"}
                    </span>
                    <span className={`tx-type-badge ${tx.type}`}>
                      {tx.type === "btc" ? "BTC" : "ARCH"}
                    </span>
                  </div>

                  <div className="history-tx-info">
                    <span className="history-tx-label">
                      {tx.direction === "send" ? "Sent" : tx.direction === "receive" ? "Received" : tx.direction === "self" ? "Self" : tx.type === "arch" ? "Transaction" : "Transaction"}
                    </span>
                    <span className="history-tx-id mono">
                      {truncateId(tx.id)}
                    </span>
                  </div>

                  <div className="history-tx-amount-col">
                    {tx.amount ? (
                      <span className={`history-tx-amount ${tx.direction}`}>
                        {tx.amount}
                      </span>
                    ) : (
                      <span className="history-tx-amount unknown">—</span>
                    )}
                    {tx.fee && (
                      <span className="history-tx-fee">Fee: {tx.fee}</span>
                    )}
                  </div>

                  <span className={`tx-status-badge ${tx.status}`}>
                    {tx.status.toUpperCase()}
                  </span>

                  <span className="history-tx-time">
                    {tx.timestampLabel}
                  </span>

                  <span className="tx-expand-chevron">
                    {expanded ? "▾" : "▸"}
                  </span>
                </button>

                {expanded && (
                  <div className="tx-expanded">
                    <div className="tx-detail-grid">
                      <div className="tx-detail-row">
                        <span className="tx-detail-label">Transaction ID</span>
                        <span className="tx-detail-value">
                          <code>{tx.id}</code>
                          <CopyButton text={tx.id} />
                        </span>
                      </div>

                      {tx.blockHeight !== null && (
                        <div className="tx-detail-row">
                          <span className="tx-detail-label">Block Height</span>
                          <span className="tx-detail-value">{tx.blockHeight.toLocaleString()}</span>
                        </div>
                      )}

                      {tx.fee && (
                        <div className="tx-detail-row">
                          <span className="tx-detail-label">Fee</span>
                          <span className="tx-detail-value">{tx.fee}</span>
                        </div>
                      )}

                      {tx.from && (
                        <div className="tx-detail-row">
                          <span className="tx-detail-label">From</span>
                          <span className="tx-detail-value">
                            <code>{tx.from}</code>
                            <CopyButton text={tx.from} />
                          </span>
                        </div>
                      )}

                      {tx.to && (
                        <div className="tx-detail-row">
                          <span className="tx-detail-label">To</span>
                          <span className="tx-detail-value">
                            <code>{tx.to}</code>
                            <CopyButton text={tx.to} />
                          </span>
                        </div>
                      )}

                      {tx.type === "btc" && (
                        <>
                          <div className="tx-detail-row">
                            <span className="tx-detail-label">Size</span>
                            <span className="tx-detail-value">
                              {(tx.raw as any).size?.toLocaleString() ?? "—"} bytes
                              {(tx.raw as any).weight ? ` (${(tx.raw as any).weight} WU)` : ""}
                            </span>
                          </div>
                          <div className="tx-detail-row">
                            <span className="tx-detail-label">Inputs / Outputs</span>
                            <span className="tx-detail-value">
                              {((tx.raw as any).vin?.length ?? 0)} in / {((tx.raw as any).vout?.length ?? 0)} out
                            </span>
                          </div>
                        </>
                      )}

                      {tx.type === "arch" && detail?.logs && detail.logs.length > 0 && (
                        <div className="tx-detail-row tx-detail-row-full">
                          <span className="tx-detail-label">Logs</span>
                          <pre className="tx-detail-logs">{detail.logs.join("\n")}</pre>
                        </div>
                      )}

                      {tx.type === "arch" && tx.instructions.length > 0 && (
                        <div className="tx-detail-row">
                          <span className="tx-detail-label">Instructions</span>
                          <span className="tx-detail-value">{tx.instructions.join(", ")}</span>
                        </div>
                      )}
                    </div>

                    <div className="tx-detail-actions">
                      <a
                        href={
                          tx.type === "arch"
                            ? archExplorerUrl(tx.rawId, network)
                            : btcExplorerUrl(tx.rawId, network)
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="explorer-link"
                      >
                        View on {tx.type === "arch" ? "Arch Explorer" : "Mempool"} ↗
                      </a>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!isLoading && hasMore && (
        <div className="history-load-more">
          <button
            className="btn-secondary"
            onClick={handleLoadMore}
            disabled={loadingMore}
            type="button"
          >
            {loadingMore ? (
              <>
                <span className="spinner small" /> Loading...
              </>
            ) : (
              "Load More"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
