import { useState, useEffect, useCallback } from "react";
import { useWallet } from "../../hooks/useWallet";
import { getClient } from "../../utils/sdk";
import { formatArchId, truncateAddress, formatTimestamp, formatBtc } from "../../utils/format";
import ArchIcon from "../../components/ArchIcon";

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

function BtcIcon() {
  return <span style={{ fontSize: 14, lineHeight: 1 }}>₿</span>;
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

      const tokenTxIds = new Set<string>();
      try {
        const tokenAddr = activeAccount.archAddress || activeAccount.btcAddress;
        const tokensRes = await client.getAccountTokens(tokenAddr, { archAddress: activeAccount.archAddress });
        const tokenAccounts: string[] = ((tokensRes as any)?.tokens ?? [])
          .map((t: any) => t.token_account_address)
          .filter(Boolean);

        const tokenTxResults = await Promise.allSettled(
          tokenAccounts.map((acct: string) =>
            client.getTransactionHistory(acct, { limit: 50, archAddress: acct })
          )
        );
        for (const r of tokenTxResults) {
          if (r.status === "fulfilled") {
            for (const tx of ((r.value as any)?.transactions ?? [])) {
              if (tx.txid) tokenTxIds.add(tx.txid);
            }
          }
        }
      } catch {
        // token enrichment is best-effort
      }

      try {
        const archAddr = activeAccount.archAddress || activeAccount.btcAddress;
        const archRes = await client.getTransactionHistory(archAddr, {
          limit: 20,
          page: archPage,
          archAddress: activeAccount.archAddress,
        });
        const archTxs = (archRes as any)?.transactions ?? [];
        setHasMoreArch(archTxs.length >= 20);

        for (const tx of archTxs) {
          const isToken = isAplTransaction(tx) || tokenTxIds.has(tx.txid);
          const kind: TxKind = isToken ? "apl" : "arch";
          let statusStr = "confirmed";
          const st = tx.status;
          if (typeof st === "string") {
            statusStr = st;
          } else if (typeof st === "object" && st !== null) {
            const keys = Object.keys(st);
            if (keys.includes("Processing") || keys.includes("Pending")) statusStr = "pending";
            else if (keys.includes("Failed") || keys.includes("Rejected")) statusStr = "failed";
          } else if (!tx.block_height) {
            statusStr = "pending";
          }
          items.push({
            txid: tx.txid,
            displayTxid: truncateAddress(formatArchId(tx.txid), 8),
            type: kind,
            direction: "unknown",
            timestamp: tx.created_at || "",
            status: statusStr,
            explorerUrl: `${archExplorer}${tx.txid}`,
          });
        }
      } catch (e: any) {
        console.warn("[History] Arch transaction fetch failed:", e?.message);
      }

      try {
        const btcTxs = await client.getBtcTransactions(activeAccount.btcAddress);
        const rawList = (btcTxs as any[]) ?? [];

        const fullTxs = await Promise.all(
          rawList.map(async (entry) => {
            if (typeof entry === "object" && entry.txid) return entry;
            const txid = typeof entry === "string" ? entry : null;
            if (!txid) return null;
            try {
              return await client.getBtcTransaction(txid);
            } catch {
              return { txid };
            }
          })
        );

        for (const tx of fullTxs) {
          if (!tx) continue;
          const txid = tx.txid;
          if (!txid) continue;

          const { direction, amountSats } = tx.input || tx.vin
            ? parseBtcTx(tx, activeAccount.btcAddress)
            : { direction: "unknown" as const, amountSats: 0 };

          const statusObj = tx.status;
          const isConfirmed =
            typeof statusObj === "object" && statusObj !== null
              ? Boolean(statusObj.confirmed)
              : false;
          const blockTime = statusObj?.block_time;

          items.push({
            txid,
            displayTxid: truncateAddress(txid, 8),
            type: "btc",
            direction,
            amount: amountSats > 0 ? formatBtc(amountSats) : undefined,
            timestamp: blockTime ? String(blockTime * 1000) : "",
            status: isConfirmed ? "confirmed" : "pending",
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
                      {tx.type === "apl" && <span className="tx-direction-tag" style={{ color: "#7b68ee" }}>APL Token{" "}</span>}
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
