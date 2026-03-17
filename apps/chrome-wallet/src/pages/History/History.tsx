import { useState, useEffect, useCallback } from "react";
import { useWallet } from "../../hooks/useWallet";
import { getClient } from "../../utils/sdk";
import { formatArchId, truncateAddress, formatTimestamp, formatBtc } from "../../utils/format";

type Tab = "all" | "arch" | "btc";

interface TxItem {
  txid: string;
  displayTxid: string;
  type: "arch" | "btc";
  direction: "in" | "out" | "self" | "unknown";
  amount?: string;
  timestamp: string;
  status: string;
  explorerUrl: string;
}

function parseBtcTx(tx: any, walletAddress: string): { direction: "in" | "out" | "self" | "unknown"; amountSats: number } {
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

export default function History() {
  const { activeAccount, state } = useWallet();
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
      const client = await getClient();
      const items: TxItem[] = [];

      try {
        const archRes = await client.getTransactionHistory(activeAccount.btcAddress, {
          limit: 20,
          page: archPage,
        });
        const archTxs = (archRes as any)?.transactions ?? [];
        setHasMoreArch(archTxs.length >= 20);

        for (const tx of archTxs) {
          items.push({
            txid: tx.txid,
            displayTxid: truncateAddress(formatArchId(tx.txid), 8),
            type: "arch",
            direction: "unknown",
            timestamp: tx.created_at || "",
            status: tx.status?.type ?? (tx.block_height ? "confirmed" : "pending"),
            explorerUrl: `${archExplorer}${tx.txid}`,
          });
        }
      } catch {
        // arch txs may not be available
      }

      try {
        const btcTxs = await client.getBtcTransactions(activeAccount.btcAddress);
        for (const tx of (btcTxs as any[]) ?? []) {
          const txid = typeof tx === "string" ? tx : tx.txid;
          if (!txid) continue;

          const { direction, amountSats } = typeof tx === "object"
            ? parseBtcTx(tx, activeAccount.btcAddress)
            : { direction: "unknown" as const, amountSats: 0 };

          const blockTime = tx?.status?.block_time;

          items.push({
            txid,
            displayTxid: truncateAddress(txid, 8),
            type: "btc",
            direction,
            amount: amountSats > 0 ? formatBtc(amountSats) : undefined,
            timestamp: blockTime ? String(blockTime * 1000) : "",
            status: tx?.status?.confirmed ? "confirmed" : "pending",
            explorerUrl: `${btcExplorer}${txid}`,
          });
        }
      } catch {
        // btc txs may not be available
      }

      const now = Date.now();
      items.sort((a, b) => {
        const aPending = a.status === "pending" || a.status === "unconfirmed";
        const bPending = b.status === "pending" || b.status === "unconfirmed";
        if (aPending && !bPending) return -1;
        if (!aPending && bPending) return 1;
        const ta = a.timestamp ? new Date(Number(a.timestamp) || a.timestamp).getTime() : now;
        const tb = b.timestamp ? new Date(Number(b.timestamp) || b.timestamp).getTime() : now;
        return tb - ta;
      });

      setTransactions(items);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [activeAccount, archPage, archExplorer, btcExplorer]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const filtered =
    tab === "all" ? transactions
    : transactions.filter((tx) => tx.type === tab);

  return (
    <>
      <div className="tabs">
        <button className={`tab ${tab === "all" ? "active" : ""}`} onClick={() => setTab("all")}>
          All
        </button>
        <button className={`tab ${tab === "arch" ? "active" : ""}`} onClick={() => setTab("arch")}>
          ⟠ Arch
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
          {filtered.map((tx) => {
            const dirClass =
              tx.direction === "in" ? "inbound"
              : tx.direction === "out" ? "outbound"
              : "neutral";

            const dirIcon =
              tx.direction === "in" ? "↓"
              : tx.direction === "out" ? "↑"
              : tx.direction === "self" ? "↻"
              : "↔";

            return (
              <a
                key={`${tx.type}-${tx.txid}`}
                href={tx.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div className="tx-row" style={{ cursor: "pointer" }}>
                  <div className={`tx-dir ${dirClass}`}>
                    {tx.type === "btc" ? "₿" : "⟠"}
                  </div>
                  <div className="tx-info">
                    <div className="tx-label">
                      {tx.type === "btc" && tx.direction !== "unknown" && (
                        <span className="tx-direction-tag">
                          {tx.direction === "in" ? "Received" : tx.direction === "out" ? "Sent" : "Self"}{" "}
                        </span>
                      )}
                      {tx.displayTxid}
                    </div>
                    <div className="tx-time">
                      {tx.amount && (
                        <span className={`tx-amount-inline ${tx.direction === "in" ? "inbound" : tx.direction === "out" ? "outbound" : ""}`}>
                          {tx.direction === "in" ? "+" : tx.direction === "out" ? "-" : ""}{tx.amount}
                          {" · "}
                        </span>
                      )}
                      {tx.timestamp ? formatTimestamp(tx.timestamp) : "Just now"}
                    </div>
                  </div>
                  <span
                    className={`badge ${
                      tx.status === "confirmed" || tx.status === "processed"
                        ? "badge-success"
                        : tx.status === "failed"
                          ? "badge-failed"
                          : "badge-pending"
                    }`}
                  >
                    {tx.status}
                  </span>
                </div>
              </a>
            );
          })}
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
