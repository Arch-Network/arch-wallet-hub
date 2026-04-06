import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { getClient } from "../../utils/sdk";
import { formatBtc, formatArch, formatTokenAmount, formatArchId, truncateAddress, formatTimestamp, btcTxTimestampMs } from "../../utils/format";
import { enrichTokenFromRpc, getArchRpcUrl } from "../../utils/arch-rpc";
import ArchIcon from "../../components/ArchIcon";

interface TokenBalance {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  uiAmount: string;
  image?: string;
}

interface RecentTx {
  txid: string;
  type: "arch" | "btc";
  direction: "in" | "out" | "unknown";
  amount?: string;
  timestamp?: string;
  status: string;
}

function SkeletonBalance() {
  return (
    <div className="balance-hero">
      <div className="skeleton skeleton-balance" />
      <div className="skeleton skeleton-balance-label" />
    </div>
  );
}

function SkeletonActions() {
  return (
    <div className="action-bar">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="skeleton skeleton-action" />
      ))}
    </div>
  );
}

function SkeletonAssetRow() {
  return (
    <div className="asset-row">
      <div className="skeleton skeleton-icon" />
      <div className="asset-info">
        <div className="skeleton skeleton-text" style={{ width: "50%" }} />
        <div className="skeleton skeleton-text-sm" style={{ width: "30%" }} />
      </div>
      <div className="skeleton skeleton-text" style={{ width: 60, marginLeft: "auto" }} />
    </div>
  );
}

function SkeletonTxRow() {
  return (
    <div className="tx-row">
      <div className="skeleton" style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0 }} />
      <div className="tx-info">
        <div className="skeleton skeleton-text" style={{ width: "60%" }} />
        <div className="skeleton skeleton-text-sm" style={{ width: "40%" }} />
      </div>
      <div className="skeleton" style={{ width: 56, height: 18, borderRadius: 10 }} />
    </div>
  );
}

export default function Dashboard() {
  const { activeAccount, state } = useWallet();
  const navigate = useNavigate();

  const [btcBalance, setBtcBalance] = useState<number | null>(null);
  const [btcPending, setBtcPending] = useState<number>(0);
  const [archLamports, setArchLamports] = useState<number | null>(null);
  const [archAddress, setArchAddress] = useState<string>("");
  const [tokens, setTokens] = useState<TokenBalance[] | null>(null);
  const [recentTxs, setRecentTxs] = useState<RecentTx[] | null>(null);

  const [overviewLoaded, setOverviewLoaded] = useState(false);
  const [tokensLoaded, setTokensLoaded] = useState(false);
  const [txsLoaded, setTxsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [airdropLoading, setAirdropLoading] = useState(false);

  const fetchAll = useCallback(async (opts?: { noCache?: boolean }) => {
    if (!activeAccount) return;
    setError(null);

    const client = await getClient();
    const addr = activeAccount.btcAddress;

    const overviewPromise = client.getWalletOverview(addr, { noCache: opts?.noCache, archAddress: activeAccount.archAddress }).then((overview: any) => {
      const btcSummary = overview?.btc?.summary;
      let confirmedSats = 0;
      let pendingSats = 0;

      if (btcSummary?.chain_stats) {
        confirmedSats = (btcSummary.chain_stats.funded_txo_sum ?? 0) - (btcSummary.chain_stats.spent_txo_sum ?? 0);
        pendingSats = (btcSummary.mempool_stats?.funded_txo_sum ?? 0) - (btcSummary.mempool_stats?.spent_txo_sum ?? 0);
      } else if (Array.isArray(btcSummary?.outputs)) {
        for (const utxo of btcSummary.outputs) {
          const val = Number(utxo.value ?? 0);
          if (utxo.spent?.spent) continue;
          if (utxo.status?.confirmed) {
            confirmedSats += val;
          } else {
            pendingSats += val;
          }
        }
      } else if (typeof btcSummary?.value === "number") {
        confirmedSats = btcSummary.value;
      }

      const lamports = overview?.arch?.account?.lamports_balance ?? 0;
      const archAddr = activeAccount.archAddress ?? overview?.archAccountAddress ?? "";
      setBtcBalance(confirmedSats);
      setBtcPending(pendingSats);
      setArchLamports(lamports);
      setArchAddress(archAddr);
      setOverviewLoaded(true);

      const btcTxItems: RecentTx[] = [];
      const outputs = Array.isArray(btcSummary?.outputs) ? btcSummary.outputs : [];
      const seen = new Set<string>();
      for (const o of outputs) {
        const txid = o?.txid;
        if (!txid || seen.has(txid)) continue;
        seen.add(txid);
        const isConfirmed = o?.status?.confirmed === true;
        const oTime = btcTxTimestampMs(o);
        btcTxItems.push({
          txid,
          type: "btc",
          direction: "in",
          amount: typeof o.value === "number" ? formatBtc(o.value) : undefined,
          timestamp: oTime != null ? String(oTime) : undefined,
          status: isConfirmed ? "confirmed" : "pending",
        });
      }

      const archTxItems: RecentTx[] = (overview?.arch?.recentTransactions?.transactions ?? [])
        .slice(0, 5)
        .map((tx: any) => {
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
          return {
            txid: tx.txid,
            type: "arch" as const,
            direction: "unknown" as const,
            timestamp: tx.created_at,
            status: statusStr,
          };
        });

      const merged = [...archTxItems, ...btcTxItems];
      merged.sort((a, b) => {
        const ta = a.timestamp ? new Date(Number(a.timestamp) || a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(Number(b.timestamp) || b.timestamp).getTime() : 0;
        return tb - ta;
      });
      setRecentTxs(merged.slice(0, 5));
      setTxsLoaded(true);
    }).catch((e: any) => {
      const msg = e?.message || "Failed to load balances";
      const isNetworkError = /fetch|network|ECONNREFUSED|abort/i.test(msg);
      if (!isNetworkError) setError(msg);
      setOverviewLoaded(true);
      setTxsLoaded(true);
    });

    const tokenAddr = activeAccount.archAddress || addr;
    const rpcUrl = getArchRpcUrl(state.network);
    const tokensPromise = client.getAccountTokens(tokenAddr, { archAddress: activeAccount.archAddress }).then(async (res: any) => {
      const rawTokens = res?.tokens ?? [];
      const enriched = await Promise.all(
        rawTokens.map(async (t: any) => {
          const base = {
            mint: t.mint_address as string,
            symbol: t.symbol || truncateAddress(t.mint_address, 4),
            name: t.name || "APL Token",
            balance: Number(t.amount) || 0,
            decimals: t.decimals ?? 0,
            uiAmount: t.ui_amount || formatTokenAmount(Number(t.amount) || 0, t.decimals ?? 0),
            image: t.image as string | undefined,
          };
          const needsEnrich = !t.name || !t.symbol || (!t.decimals && t.decimals !== undefined);
          if (!needsEnrich) return base;
          try {
            const rpc = await enrichTokenFromRpc(rpcUrl, t);
            if (rpc.name) base.name = rpc.name;
            if (rpc.symbol) base.symbol = rpc.symbol;
            if (rpc.image) base.image = rpc.image;
            if (rpc.decimals != null) base.decimals = rpc.decimals;
            if (rpc.uiAmount) base.uiAmount = rpc.uiAmount;
          } catch { /* best-effort */ }
          return base;
        }),
      );
      setTokens(enriched);
      setTokensLoaded(true);
    }).catch((e: any) => {
      console.warn("[Dashboard] getAccountTokens failed:", e?.message);
      setTokens([]);
      setTokensLoaded(true);
    });

    await Promise.allSettled([overviewPromise, tokensPromise]);
  }, [activeAccount]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setOverviewLoaded(false);
    setTokensLoaded(false);
    setTxsLoaded(false);
    await fetchAll({ noCache: true });
    setRefreshing(false);
  }, [fetchAll]);

  const handleAirdrop = useCallback(async () => {
    if (!archAddress) return;
    setAirdropLoading(true);
    try {
      const client = await getClient();
      await client.requestFaucetAirdrop(archAddress);

      const prevLamports = archLamports ?? 0;
      const MAX_ATTEMPTS = 12;
      const POLL_INTERVAL = 500;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        try {
          const fresh = await client.getArchAccount(activeAccount!.btcAddress) as any;
          const newLamports = fresh?.lamports_balance ?? fresh?.lamports ?? 0;
          if (newLamports !== prevLamports) {
            setArchLamports(newLamports);
            break;
          }
        } catch {
          /* ignore */
        }
      }
    } catch (e: any) {
      setError(e?.message || "Airdrop failed");
    } finally {
      setAirdropLoading(false);
    }
  }, [archAddress, archLamports, activeAccount]);

  const isTestnet = state.network === "testnet4";
  const balancesReady = overviewLoaded;

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      {/* Balance hero -- skeleton until overview loads */}
      {balancesReady ? (
        <div className="balance-hero">
          <div className="balance-amount">{formatArch(archLamports ?? 0)}</div>
          <div className="balance-label">
            Total ARCH Balance
            <button
              className="refresh-btn"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh balances"
            >
              <span className={refreshing ? "refresh-icon spinning" : "refresh-icon"}>↻</span>
            </button>
          </div>
        </div>
      ) : (
        <SkeletonBalance />
      )}

      {/* Action bar */}
      {balancesReady ? (
        <div className="action-bar">
          <button className="action-btn" onClick={() => navigate("/send")}>
            <span className="action-btn-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13" /><path d="M22 2L15 22l-4-9-9-4 20-7z" />
              </svg>
            </span>
            Send
          </button>
          <button className="action-btn" onClick={() => navigate("/receive")}>
            <span className="action-btn-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v13" /><path d="M5 12l7 7 7-7" /><path d="M3 21h18" />
              </svg>
            </span>
            Receive
          </button>
          {isTestnet && (
            <button className="action-btn" onClick={handleAirdrop} disabled={airdropLoading}>
              <span className="action-btn-icon">
                {airdropLoading ? (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="refresh-icon spinning">
                    <path d="M21 12a9 9 0 1 1-6.2-8.6" />
                  </svg>
                ) : (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2v6" /><path d="M8 6l4 4 4-4" />
                    <path d="M4 14c0 4.4 3.6 8 8 8s8-3.6 8-8" />
                    <path d="M7 13.5C7 11 9.2 9 12 9s5 2 5 4.5" />
                  </svg>
                )}
              </span>
              Airdrop
            </button>
          )}
          <button className="action-btn" onClick={() => navigate("/tokens")}>
            <span className="action-btn-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </span>
            Tokens
          </button>
        </div>
      ) : (
        <SkeletonActions />
      )}

      {/* Assets section -- progressive loading */}
      <div className="section">
        <div className="section-title">Portfolio</div>
        <div className="card">
          {balancesReady ? (
            <div className={`asset-row ${btcPending !== 0 ? "has-pending" : ""}`}>
              <div className="asset-icon btc">₿</div>
              <div className="asset-info">
                <div className="asset-name">Bitcoin</div>
                <div className="asset-sub">BTC</div>
              </div>
              <div className="asset-balance-group">
                {btcPending !== 0 ? (
                  <>
                    <div className="asset-balance">{formatBtc((btcBalance ?? 0) + btcPending)}</div>
                    <div className="asset-balance-breakdown">
                      <span className="asset-confirmed">{formatBtc(btcBalance ?? 0)} confirmed</span>
                      <span className={`asset-pending-line ${btcPending > 0 ? "incoming" : "outgoing"}`}>
                        {btcPending > 0 ? "+" : ""}{(btcPending / 1e8).toFixed(8)} pending
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="asset-balance">{formatBtc(btcBalance ?? 0)}</div>
                )}
              </div>
            </div>
          ) : (
            <SkeletonAssetRow />
          )}

          {balancesReady ? (
            <div className="asset-row">
              <div className="asset-icon arch"><ArchIcon size={18} /></div>
              <div className="asset-info">
                <div className="asset-name">Arch</div>
                <div className="asset-sub">ARCH</div>
              </div>
              <div className="asset-balance">{formatArch(archLamports ?? 0)}</div>
            </div>
          ) : (
            <SkeletonAssetRow />
          )}

          {tokensLoaded
            ? (tokens ?? []).map((tk) => (
                <div className="asset-row" key={tk.mint} onClick={() => navigate("/tokens")} style={{ cursor: "pointer" }}>
                  <div className="asset-icon apl">
                    {tk.image
                      ? <img src={tk.image} alt={tk.symbol} style={{ width: 24, height: 24, borderRadius: "50%" }} />
                      : <ArchIcon size={18} color="#7b68ee" />}
                  </div>
                  <div className="asset-info">
                    <div className="asset-name">{tk.name}</div>
                    <div className="asset-sub">{tk.symbol}</div>
                  </div>
                  <div className="asset-balance">{tk.uiAmount}</div>
                </div>
              ))
            : <SkeletonAssetRow />
          }
        </div>
      </div>

      {/* Recent activity -- progressive loading */}
      <div className="section">
        <div className="card-header">
          <div className="section-title">Recent Activity</div>
          <button className="btn btn-sm btn-secondary" onClick={() => navigate("/history")}>
            View all
          </button>
        </div>
        <div className="card">
          {txsLoaded ? (
            (recentTxs ?? []).length > 0 ? (
              recentTxs!.map((tx) => (
                <div className="tx-row" key={`${tx.type}-${tx.txid}`}>
                  <div className={`tx-dir ${tx.type === "btc" ? (tx.direction === "in" ? "inbound" : "outbound") : "arch"}`}>
                    {tx.type === "btc" ? "₿" : <ArchIcon size={14} />}
                  </div>
                  <div className="tx-info">
                    <div className="tx-label">
                      {tx.type === "btc" && tx.amount && (
                        <span className="tx-direction-tag">{tx.direction === "in" ? "+" : ""}{tx.amount}{" "}</span>
                      )}
                      {truncateAddress(tx.type === "arch" ? formatArchId(tx.txid) : tx.txid, 8)}
                    </div>
                    <div className="tx-time">{tx.timestamp ? formatTimestamp(tx.timestamp) : "Just now"}</div>
                  </div>
                  <span className={`badge ${tx.status === "confirmed" || tx.status === "processed" ? "badge-success" : tx.status === "failed" ? "badge-failed" : "badge-pending"}`}>
                    {tx.status}
                  </span>
                </div>
              ))
            ) : (
              <div style={{ padding: 12, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
                No recent transactions
              </div>
            )
          ) : (
            <>
              <SkeletonTxRow />
              <SkeletonTxRow />
              <SkeletonTxRow />
            </>
          )}
        </div>
      </div>
    </>
  );
}
