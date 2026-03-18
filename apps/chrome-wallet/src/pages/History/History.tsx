import { useState, useEffect, useCallback } from "react";
import { useWallet } from "../../hooks/useWallet";
import { getClient } from "../../utils/sdk";
import { formatArchId, truncateAddress, formatTimestamp, formatBtc } from "../../utils/format";

type Tab = "all" | "arch" | "btc";
type TxKind = "arch" | "apl" | "btc";

interface TxItem {
  txid: string;
  displayTxid: string;
  type: TxKind;
  direction: "in" | "out" | "self" | "unknown";
  amount?: string;
  timestamp: string;
  status: string;
  explorerUrl: string;
}

function ArchIcon({ size = 14, color = "#c19a5b" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="-310 -10 1220 900" fill="none">
      <path d="M554.569 873.994H514.625C510.446 873.994 506.52 871.884 504.291 868.317L311.385 560.676C306.851 553.492 299.784 552.713 296.947 552.713C294.136 552.713 286.968 553.467 282.51 560.676L89.6039 868.317C87.3749 871.884 83.4489 873.994 79.2696 873.994H39.3258C29.7767 873.994 23.951 863.569 28.9915 855.531L233.093 530.181C246.923 508.076 270.833 494.963 297.023 494.963C323.239 494.963 347.124 508.076 360.954 530.181L565.055 855.531C570.096 863.569 564.295 873.994 554.721 873.994H554.569Z" fill={color}/>
      <path d="M666.206 873.996H626.077C621.878 873.996 617.934 871.878 615.695 868.297L323.37 402.476C317.543 393.221 308.026 387.951 297.033 387.951C286.066 387.951 276.447 393.221 270.696 402.476L-21.6288 868.297C-23.868 871.878 -27.8122 873.996 -32.0108 873.996H-72.1394C-81.7326 873.996 -87.5852 863.53 -82.5214 855.461L220.975 371.887C237.438 345.635 265.836 329.975 297.033 329.975C312.632 329.975 327.467 333.884 340.597 341.122C353.625 348.334 364.873 358.799 373.092 371.887L676.562 855.461C681.651 863.53 675.799 873.996 666.206 873.996Z" fill={color}/>
      <path d="M773.154 873.998H733.294C729.124 873.998 725.206 871.875 722.982 868.287L334.821 244.229C326.48 230.861 312.679 223.205 296.907 223.205C281.135 223.205 267.36 230.861 258.993 244.229L-129.143 868.287C-131.367 871.875 -135.285 873.998 -139.455 873.998H-179.315C-188.844 873.998 -194.658 863.511 -189.628 855.424L209.68 213.476C228.157 183.759 259.853 165.691 294.784 165.009C331.585 164.251 365.834 183.835 385.322 215.093L783.619 855.349C788.648 863.435 782.86 873.922 773.306 873.922L773.154 873.998Z" fill={color}/>
      <path d="M884.642 873.999H844.655C840.471 873.999 836.541 871.874 834.31 868.281L346.734 85.8787C335.806 68.3182 317.676 58.2475 296.909 58.2475C276.142 58.2475 258.038 68.3182 247.084 85.8787L-240.466 868.281C-242.697 871.874 -246.627 873.999 -250.811 873.999H-290.798C-300.357 873.999 -306.189 863.499 -301.143 855.401L197.64 55.0846C219.167 20.6469 256.263 -0.000610352 297.011 -0.000610352C337.784 -0.000610352 374.854 20.5456 396.382 55.0846L895.139 855.401C900.185 863.499 894.379 873.999 884.819 873.999H884.642Z" fill={color}/>
    </svg>
  );
}

function BtcIcon() {
  return <span style={{ fontSize: 14, lineHeight: 1 }}>₿</span>;
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
          const kind: TxKind = isAplTransaction(tx) ? "apl" : "arch";
          items.push({
            txid: tx.txid,
            displayTxid: truncateAddress(formatArchId(tx.txid), 8),
            type: kind,
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
          {filtered.map((tx) => {
            const dirClass =
              tx.type === "btc"
                ? (tx.direction === "in" ? "inbound" : tx.direction === "out" ? "outbound" : "neutral")
                : tx.type === "apl" ? "apl" : "arch";

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
                    <TxIcon kind={tx.type} direction={tx.direction} />
                  </div>
                  <div className="tx-info">
                    <div className="tx-label">
                      {tx.type === "btc" && tx.direction !== "unknown" && (
                        <span className="tx-direction-tag">
                          {tx.direction === "in" ? "Received" : tx.direction === "out" ? "Sent" : "Self"}{" "}
                        </span>
                      )}
                      {tx.type === "apl" && <span className="tx-direction-tag">Token{" "}</span>}
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
