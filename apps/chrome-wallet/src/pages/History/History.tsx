import { useState, useEffect, useCallback } from "react";
import { useWallet } from "../../hooks/useWallet";
import { useBtcUsdPrice } from "../../hooks/useBtcUsdPrice";
import { getIndexer } from "../../utils/indexer";
import { reEncodeTaprootAddress } from "../../utils/addressNetwork";
import { formatArchId, truncateAddress, formatTimestamp, formatBtc, formatBtcUsd, timestampToMs } from "../../utils/format";
import { resolveBtcTxTimestampMs } from "../../utils/btc-timestamps";
import { summarizeArchTx } from "../../utils/arch-tx-summary";
import {
  type TxStatus,
  normalizeArchStatus,
  statusBadgeClass,
  statusLabel,
} from "../../utils/tx-status";
import ArchIcon from "../../components/ArchIcon";

type Tab = "all" | "arch" | "btc";
type TxKind = "arch" | "apl" | "btc";

interface TxItem {
  txid: string;
  displayTxid: string;
  type: TxKind;
  direction: "in" | "out" | "self" | "neutral" | "unknown";
  /** Primary label, e.g. "Sent BTC", "Token Transfer", "Arch Transaction". */
  label: string;
  /** Pre-signed amount string, e.g. "+0.001 BTC" or "-1024". */
  amount?: string;
  /** Raw sats for BTC, used for USD conversion. */
  amountSats?: number;
  timestamp: string;
  status: TxStatus;
  explorerUrl: string;
}

function BtcIcon({ size = 14 }: { size?: number }) {
  return <span style={{ fontSize: size, lineHeight: 1 }}>₿</span>;
}

function parseBtcTx(tx: any, walletAddress: string): { direction: "in" | "out" | "self" | "unknown"; amountSats: number } {
  let sentSats = 0;
  let receivedSats = 0;

  const vin = Array.isArray(tx.vin) ? tx.vin : [];
  const vout = Array.isArray(tx.vout) ? tx.vout : [];
  const inputs = Array.isArray(tx.input) ? tx.input : [];
  const outputs = Array.isArray(tx.output) ? tx.output : [];

  for (const inp of vin) {
    if (inp.prevout?.scriptpubkey_address === walletAddress) {
      sentSats += inp.prevout.value ?? 0;
    }
  }
  for (const inp of inputs) {
    if (inp.previous_output_data?.script_pubkey_address === walletAddress) {
      sentSats += inp.previous_output_data.value ?? 0;
    }
  }

  for (const out of vout) {
    if (out.scriptpubkey_address === walletAddress) {
      receivedSats += out.value ?? 0;
    }
  }
  for (const out of outputs) {
    if (out.script_pubkey_address === walletAddress) {
      receivedSats += out.value ?? 0;
    }
  }

  const isSend = sentSats > 0;
  const isSelf = isSend && receivedSats > 0 && sentSats === receivedSats + (tx.fee ?? 0);
  const netSats = isSend ? sentSats - receivedSats : receivedSats;

  const direction: TxItem["direction"] = isSelf
    ? "self"
    : isSend
      ? "out"
      : receivedSats > 0
        ? "in"
        : "unknown";

  return { direction, amountSats: netSats };
}

function isAplTransaction(tx: any): boolean {
  if (Array.isArray(tx.token_mints) && tx.token_mints.length > 0) return true;
  if (tx.token_transfer) return true;
  return false;
}

function TxIcon({ kind, direction }: { kind: TxKind; direction: TxItem["direction"] }) {
  if (kind === "btc") {
    return <BtcIcon size={16} />;
  }
  if (kind === "apl") {
    return <ArchIcon size={16} color="#7b68ee" />;
  }
  return <ArchIcon size={16} color="#c19a5b" />;
}

export default function History() {
  const { activeAccount, state } = useWallet();
  const { price: btcUsd } = useBtcUsdPrice();
  const [tab, setTab] = useState<Tab>("all");
  const [transactions, setTransactions] = useState<TxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [archPage, setArchPage] = useState(1);
  const [hasMoreArch, setHasMoreArch] = useState(false);

  const isTestnet = state.network === "testnet4";
  const archExplorer = isTestnet ? "https://explorer.arch.network/testnet/tx/" : "https://explorer.arch.network/mainnet/tx/";
  const btcExplorer = isTestnet ? "https://mempool.space/testnet4/tx/" : "https://mempool.space/tx/";

  const fetchTransactions = useCallback(async () => {
    if (!activeAccount) return;
    setLoading(true);
    try {
      const indexer = await getIndexer();
      const items: TxItem[] = [];
      const archAddr = activeAccount.archAddress || activeAccount.btcAddress;
      const btcAddr = reEncodeTaprootAddress(activeAccount.btcAddress, state.network);

      const tokenTxIds = new Set<string>();
      try {
        const tokensRes = await indexer.getAccountTokens(archAddr);
        const tokenAccounts: string[] = (tokensRes?.tokens ?? [])
          .map((t) => t.token_account_address as string | undefined)
          .filter((s): s is string => !!s);

        const tokenTxResults = await Promise.allSettled(
          tokenAccounts.map((acct) => indexer.getAccountTransactions(acct, 50))
        );
        for (const r of tokenTxResults) {
          if (r.status === "fulfilled") {
            for (const tx of (r.value?.transactions ?? [])) {
              const txid = (tx as any)?.txid;
              if (txid) tokenTxIds.add(String(txid));
            }
          }
        }
      } catch {
        // token enrichment is best-effort
      }

      try {
        // v2 ships chip labels + decoded token_transfer summaries inline so we
        // can derive direction/amount/label without per-tx /instructions calls.
        const archRes = await indexer
          .getAccountTransactionsV2(archAddr, 20, archPage)
          .catch(() => indexer.getAccountTransactions(archAddr, 20, archPage));
        const archTxs = archRes?.transactions ?? [];
        setHasMoreArch(archTxs.length >= 20);

        const detailedArchTxs = await Promise.all(
          (archTxs as any[]).map(async (tx) => {
            try {
              const detail = await indexer.getTransactionDetail(tx.txid);
              return { ...tx, ...(detail as Record<string, unknown>) };
            } catch {
              return tx;
            }
          })
        );

        for (const tx of detailedArchTxs) {
          const isToken = isAplTransaction(tx) || tokenTxIds.has(tx.txid);
          const kind: TxKind = isToken ? "apl" : "arch";
          const status = normalizeArchStatus(tx);
          const summary = summarizeArchTx(tx, archAddr);
          items.push({
            txid: tx.txid,
            displayTxid: truncateAddress(formatArchId(tx.txid), 8),
            type: kind,
            direction:
              summary.direction === "in" ? "in"
              : summary.direction === "out" ? "out"
              : summary.direction === "neutral" ? "neutral"
              : "unknown",
            label: summary.label,
            amount: summary.amountLabel,
            timestamp: tx.created_at || "",
            status,
            explorerUrl: `${archExplorer}${tx.txid}`,
          });
        }
      } catch (e: any) {
        console.warn("[History] Arch transaction fetch failed:", e?.message);
      }

      try {
        const btcTxs = await indexer.getBtcAddressTxs(btcAddr);
        const rawList = btcTxs ?? [];

        const fullTxs = await Promise.all(
          rawList.map(async (entry) => {
            if (typeof entry === "object" && entry !== null && (entry as any).txid) return entry as any;
            const txid = typeof entry === "string" ? entry : null;
            if (!txid) return null;
            try {
              return await indexer.getBtcTransaction(txid);
            } catch {
              return { txid };
            }
          })
        );

        for (const tx of fullTxs) {
          if (!tx) continue;
          const txid = (tx as any).txid;
          if (!txid) continue;

          const { direction, amountSats } = (tx as any).input || (tx as any).vin
            ? parseBtcTx(tx, btcAddr)
            : { direction: "unknown" as const, amountSats: 0 };

          const statusObj = (tx as any).status;
          const isConfirmed =
            typeof statusObj === "object" && statusObj !== null
              ? Boolean(statusObj.confirmed)
              : false;
          const timeMs = await resolveBtcTxTimestampMs(indexer, tx as Record<string, unknown>);

          const btcLabel =
            direction === "in" ? "Received BTC"
            : direction === "out" ? "Sent BTC"
            : direction === "self" ? "BTC Consolidation"
            : "BTC Transaction";
          const sign = direction === "out" ? "-" : direction === "in" ? "+" : "";
          items.push({
            txid,
            displayTxid: truncateAddress(txid, 8),
            type: "btc",
            direction,
            label: btcLabel,
            amount: amountSats > 0 ? `${sign}${formatBtc(amountSats)}` : undefined,
            amountSats: amountSats > 0 ? amountSats : undefined,
            timestamp: timeMs != null ? String(timeMs) : "",
            status: isConfirmed ? "confirmed" : "pending",
            explorerUrl: `${btcExplorer}${txid}`,
          });
        }
      } catch {
        // btc txs may not be available
      }

      items.sort((a, b) => {
        const aPending = a.status === "pending" || a.status === "unconfirmed";
        const bPending = b.status === "pending" || b.status === "unconfirmed";
        if (aPending && !bPending) return -1;
        if (!aPending && bPending) return 1;
        const ta = timestampToMs(a.timestamp) ?? 0;
        const tb = timestampToMs(b.timestamp) ?? 0;
        return tb - ta;
      });

      setTransactions(items);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [activeAccount, archPage, archExplorer, btcExplorer, state.network]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const filtered =
    tab === "all" ? transactions
    : tab === "arch" ? transactions.filter((tx) => tx.type === "arch" || tx.type === "apl")
    : transactions.filter((tx) => tx.type === "btc");

  return (
    <>
      <div className="tabs">
        <button className={`tab ${tab === "all" ? "active" : ""}`} onClick={() => setTab("all")}>
          All
        </button>
        <button className={`tab ${tab === "arch" ? "active" : ""}`} onClick={() => setTab("arch")}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <ArchIcon size={12} color={tab === "arch" ? "#c19a5b" : "#888"} /> Arch
          </span>
        </button>
        <button className={`tab ${tab === "btc" ? "active" : ""}`} onClick={() => setTab("btc")}>
          ₿ Bitcoin
        </button>
      </div>

      {loading ? (
        <div className="spinner-center">
          <div className="spinner" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📭</div>
          <div>No transactions yet</div>
        </div>
      ) : (
        <div className="card">
          {filtered.map((tx) => renderHistoryRow(tx, btcUsd))}
        </div>
      )}

      {hasMoreArch && tab !== "btc" && (
        <button
          className="btn btn-secondary btn-full"
          style={{ marginTop: 12 }}
          onClick={() => setArchPage((p) => p + 1)}
        >
          Load more
        </button>
      )}
    </>
  );
}

function ArrowDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14" />
      <path d="M19 12l-7 7-7-7" />
    </svg>
  );
}

function ArrowUp() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

function renderHistoryRow(tx: TxItem, btcUsd: number | null) {
  const isSuccess = tx.status === "confirmed" || tx.status === "processed";
  const showBadge = !isSuccess; // success rows go uncluttered

  const dirClass =
    tx.direction === "in" ? "inbound"
    : tx.direction === "out" ? "outbound"
    : tx.type === "btc" ? "neutral"
    : tx.type === "apl" ? "apl"
    : "arch";

  const usdSubtitle = tx.type === "btc" && tx.amountSats != null
    ? formatBtcUsd(tx.amountSats, btcUsd)
    : null;

  return (
    <a
      key={`${tx.type}-${tx.txid}`}
      href={tx.explorerUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="tx-row-link"
    >
      <div className="tx-row tx-row-activity">
        <div className={`tx-dir ${dirClass}`}>
          {tx.direction === "in" ? <ArrowDown />
            : tx.direction === "out" ? <ArrowUp />
            : <TxIcon kind={tx.type} direction={tx.direction} />}
        </div>
        <div className="tx-info">
          <div className="tx-activity-title">
            <span className="tx-activity-label">{tx.label}</span>
            {tx.amount && (
              <span className={`tx-activity-amount ${tx.direction === "out" ? "outbound" : tx.direction === "in" ? "inbound" : ""}`}>
                {tx.amount}
              </span>
            )}
          </div>
          <div className="tx-activity-meta">
            <span className="tx-time">
              {tx.timestamp
                ? formatTimestamp(tx.timestamp)
                : tx.status === "pending" || tx.status === "unconfirmed"
                  ? "Pending"
                  : "Time unavailable"}
            </span>
            {usdSubtitle && <span className="tx-activity-usd">{usdSubtitle}</span>}
            <span className="tx-activity-ref mono">{tx.displayTxid}</span>
          </div>
        </div>
        {showBadge && (
          <span className={`badge ${statusBadgeClass(tx.status)}`}>
            {statusLabel(tx.status)}
          </span>
        )}
      </div>
    </a>
  );
}
