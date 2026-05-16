import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { useBtcUsdPrice } from "../../hooks/useBtcUsdPrice";
import { getIndexer } from "../../utils/indexer";
import { fetchWalletOverview } from "../../utils/wallet-overview";
import { reEncodeTaprootAddress } from "../../utils/addressNetwork";
import { deriveArchAccountAddress } from "../../utils/sdk";
import { formatBtc, formatArch, formatTokenAmount, formatArchId, truncateAddress, formatTimestamp, timestampToMs, formatBtcUsd } from "../../utils/format";
import { enrichTokenFromRpc } from "../../utils/arch-rpc";
import { resolveBtcTxTimestampMs } from "../../utils/btc-timestamps";
import { summarizeArchTx, type ArchTxSummary } from "../../utils/arch-tx-summary";
import { normalizeArchStatus, statusBadgeClass, statusLabel, type TxStatus } from "../../utils/tx-status";
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
  direction: "in" | "out" | "unknown" | "neutral";
  /** Primary line, e.g. "Sent BTC", "Received Token", "Arch Transaction". */
  label: string;
  /** Signed pre-formatted amount, e.g. "+0.00012345 BTC" or "-1024 APL". */
  amountLabel?: string;
  /** USD equivalent shown beneath the amount, e.g. "$12.34". Mainnet only. */
  usdSubtitle?: string;
  /** Raw amount in sats for BTC, used to compute USD lazily once price loads. */
  sats?: number;
  timestamp?: string;
  /** Normalized status (success|failed|pending|confirmed|unconfirmed). */
  status: TxStatus;
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

interface BtcTxDelta {
  direction: "in" | "out" | "unknown";
  /** Net change for this address in sats. Always >= 0 (sign comes from direction). */
  sats: number;
}

function parseRecentBtcTx(tx: any, walletAddress: string): BtcTxDelta {
  let sentSats = 0;
  let receivedSats = 0;
  const vin = Array.isArray(tx?.vin) ? tx.vin : [];
  const vout = Array.isArray(tx?.vout) ? tx.vout : [];
  const inputs = Array.isArray(tx?.input) ? tx.input : [];
  const outputs = Array.isArray(tx?.output) ? tx.output : [];

  for (const input of vin) {
    if (input?.prevout?.scriptpubkey_address === walletAddress) {
      sentSats += Number(input.prevout.value ?? 0);
    }
  }
  for (const input of inputs) {
    if (input?.previous_output_data?.script_pubkey_address === walletAddress) {
      sentSats += Number(input.previous_output_data.value ?? 0);
    }
  }
  for (const output of vout) {
    if (output?.scriptpubkey_address === walletAddress) {
      receivedSats += Number(output.value ?? 0);
    }
  }
  for (const output of outputs) {
    if (output?.script_pubkey_address === walletAddress) {
      receivedSats += Number(output.value ?? 0);
    }
  }

  const direction: BtcTxDelta["direction"] =
    sentSats > 0 ? "out" : receivedSats > 0 ? "in" : "unknown";
  const sats = sentSats > 0 ? Math.max(sentSats - receivedSats, 0) : receivedSats;

  return { direction, sats };
}

function buildBtcAmountLabel(direction: BtcTxDelta["direction"], sats: number): string | undefined {
  if (sats <= 0) return undefined;
  const sign = direction === "out" ? "-" : "+";
  return `${sign}${formatBtc(sats)}`;
}

function btcLabel(direction: BtcTxDelta["direction"]): string {
  if (direction === "in") return "Received BTC";
  if (direction === "out") return "Sent BTC";
  return "BTC Transaction";
}

function isBtcTxConfirmed(tx: any): boolean {
  if (typeof tx?.status === "object" && tx.status !== null) {
    return tx.status.confirmed === true;
  }
  return Boolean(tx?.block_height || tx?.blockHeight || tx?.confirmed);
}

export default function Dashboard() {
  const { activeAccount, state } = useWallet();
  const navigate = useNavigate();
  const { price: btcUsd } = useBtcUsdPrice();

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

  // Parallax: drive a CSS variable on .app-body so the hero's city
  // background pans slower than the foreground as you scroll.
  // rAF-throttled to keep scrolling buttery even on cheap devices.
  useEffect(() => {
    const body = document.querySelector(".app-body") as HTMLElement | null;
    if (!body) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      body.style.setProperty("--parallax-y", `${body.scrollTop * 0.35}px`);
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(apply);
    };
    apply();
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      body.removeEventListener("scroll", onScroll);
      body.style.removeProperty("--parallax-y");
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const fetchAll = useCallback(async (opts?: { noCache?: boolean }) => {
    if (!activeAccount) return;
    setError(null);

    const indexer = await getIndexer();
    const inputAddr = activeAccount.btcAddress;
    const btcAddrForNetwork = reEncodeTaprootAddress(inputAddr, state.network);
    const archAddr =
      activeAccount.archAddress ||
      (activeAccount.publicKeyHex ? deriveArchAccountAddress(activeAccount.publicKeyHex) : "");

    const overviewPromise = fetchWalletOverview(indexer, {
      inputAddress: inputAddr,
      archAccountAddress: archAddr,
      btcAddress: btcAddrForNetwork,
      noCache: opts?.noCache
    }).then(async (overview) => {
      const btcSummary = overview?.btc?.summary;
      let confirmedSats = 0;
      let pendingSats = 0;

      if (btcSummary?.chain_stats) {
        confirmedSats = (btcSummary.chain_stats.funded_txo_sum ?? 0) - (btcSummary.chain_stats.spent_txo_sum ?? 0);
        pendingSats = (btcSummary.mempool_stats?.funded_txo_sum ?? 0) - (btcSummary.mempool_stats?.spent_txo_sum ?? 0);
      } else if (Array.isArray(btcSummary?.outputs)) {
        for (const utxo of btcSummary.outputs as any[]) {
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
      try {
        const btcTxs = await indexer.getBtcAddressTxs(btcAddrForNetwork);
        const rawList = (btcTxs ?? []).slice(0, 5);
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
          const txid = tx?.txid as string | undefined;
          if (!txid) continue;
          const timeMs = await resolveBtcTxTimestampMs(indexer, tx as Record<string, unknown>);
          const { direction, sats } = parseRecentBtcTx(tx, btcAddrForNetwork);
          btcTxItems.push({
            txid,
            type: "btc",
            direction,
            sats,
            label: btcLabel(direction),
            amountLabel: buildBtcAmountLabel(direction, sats),
            timestamp: timeMs != null ? String(timeMs) : undefined,
            status: isBtcTxConfirmed(tx) ? "confirmed" : "unconfirmed",
          });
        }
      } catch (e: any) {
        console.warn("[Dashboard] getBtcAddressTxs failed:", e?.message);
      }

      const archTxItems: RecentTx[] = (overview?.arch?.recentTransactions?.transactions ?? [])
        .slice(0, 5)
        .map((tx: any): RecentTx => {
          const status = normalizeArchStatus(tx);
          const summary: ArchTxSummary = summarizeArchTx({ ...tx, status }, archAddr);
          return {
            txid: tx.txid,
            type: "arch",
            direction: summary.direction,
            label: summary.label,
            amountLabel: summary.amountLabel,
            timestamp: tx.created_at,
            status,
          };
        });

      const merged = [...archTxItems, ...btcTxItems];
      merged.sort((a, b) => {
        const ta = timestampToMs(a.timestamp) ?? 0;
        const tb = timestampToMs(b.timestamp) ?? 0;
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

    const tokenAddr = archAddr || inputAddr;
    const tokensPromise = indexer.getAccountTokens(tokenAddr).then(async (res) => {
      const rawTokens = res?.tokens ?? [];
      const enriched = await Promise.all(
        rawTokens.map(async (t) => {
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
            const rpc = await enrichTokenFromRpc(indexer, t);
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
  }, [activeAccount, state.network]);

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
      const indexer = await getIndexer();
      await indexer.requestFaucetAirdrop(archAddress);

      const prevLamports = archLamports ?? 0;
      const MAX_ATTEMPTS = 12;
      const POLL_INTERVAL = 500;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        try {
          const fresh = await indexer.getAccountSummary(archAddress);
          const newLamports = fresh?.lamports_balance ?? (fresh as any)?.lamports ?? 0;
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
  }, [archAddress, archLamports]);

  const isTestnet = state.network === "testnet4";
  const balancesReady = overviewLoaded;

  return (
    <>
      {/* Balance hero -- bleeds edge-to-edge of the main column in wide
          side panel mode. Lives outside .dashboard-shell so it isn't
          constrained by the inner max-width. */}
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

      <div className="dashboard-shell">
      {error && <div className="error-banner">{error}</div>}

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

      {/* Portfolio + Recent Activity. The grid wrapper collapses to a
          single column on narrow viewports and splits side-by-side on
          wide side panels (>= 880px). */}
      <div className="dashboard-grid">
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
                    {formatBtcUsd((btcBalance ?? 0) + btcPending, btcUsd) && (
                      <div className="asset-balance-usd">
                        {formatBtcUsd((btcBalance ?? 0) + btcPending, btcUsd)}
                      </div>
                    )}
                    <div className="asset-balance-breakdown">
                      <span className="asset-confirmed">{formatBtc(btcBalance ?? 0)} confirmed</span>
                      <span className={`asset-pending-line ${btcPending > 0 ? "incoming" : "outgoing"}`}>
                        {btcPending > 0 ? "+" : ""}{(btcPending / 1e8).toFixed(8)} pending
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="asset-balance">{formatBtc(btcBalance ?? 0)}</div>
                    {formatBtcUsd(btcBalance ?? 0, btcUsd) && (
                      <div className="asset-balance-usd">{formatBtcUsd(btcBalance ?? 0, btcUsd)}</div>
                    )}
                  </>
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
            ? (() => {
                const MAX_INLINE_TOKENS = 2;
                const allTokens = tokens ?? [];
                const visible = allTokens.slice(0, MAX_INLINE_TOKENS);
                const hiddenCount = allTokens.length - visible.length;
                return (
                  <>
                    {visible.map((tk) => (
                      <div
                        className="asset-row"
                        key={tk.mint}
                        onClick={() => navigate(`/tokens/${encodeURIComponent(tk.mint)}`)}
                        style={{ cursor: "pointer" }}
                      >
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
                    ))}
                    {hiddenCount > 0 && (
                      <div className="token-more-row" onClick={() => navigate("/tokens")}>
                        <div className="asset-icon apl">
                          <ArchIcon size={18} color="#7b68ee" />
                        </div>
                        <div className="token-more-label">
                          + {hiddenCount} more token{hiddenCount !== 1 ? "s" : ""}
                        </div>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </div>
                    )}
                  </>
                );
              })()
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
              recentTxs!.map((tx) => renderActivityRow(tx, btcUsd))
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
      </div>
      </div>
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

function renderActivityRow(tx: RecentTx, btcUsd: number | null) {
  const isSuccess = tx.status === "success" || tx.status === "confirmed";
  const showBadge = !isSuccess; // success rows go uncluttered

  const dirClass =
    tx.direction === "in" ? "inbound" :
    tx.direction === "out" ? "outbound" :
    tx.type === "btc" ? "neutral" : "arch";

  const usdSubtitle = tx.type === "btc" && tx.sats != null
    ? formatBtcUsd(tx.sats, btcUsd)
    : undefined;

  return (
    <div className="tx-row tx-row-activity" key={`${tx.type}-${tx.txid}`}>
      <div className={`tx-dir ${dirClass}`}>
        {tx.direction === "in" ? <ArrowDown />
          : tx.direction === "out" ? <ArrowUp />
          : tx.type === "btc" ? <span style={{ fontSize: 14, lineHeight: 1 }}>₿</span>
          : <ArchIcon size={14} />}
      </div>
      <div className="tx-info">
        <div className="tx-activity-title">
          <span className="tx-activity-label">{tx.label}</span>
          {tx.amountLabel && (
            <span className={`tx-activity-amount ${tx.direction === "out" ? "outbound" : tx.direction === "in" ? "inbound" : ""}`}>
              {tx.amountLabel}
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
          <span className="tx-activity-ref mono">
            {truncateAddress(tx.type === "arch" ? formatArchId(tx.txid) : tx.txid, 6)}
          </span>
        </div>
      </div>
      {showBadge && (
        <span className={`badge ${statusBadgeClass(tx.status)}`}>
          {statusLabel(tx.status)}
        </span>
      )}
    </div>
  );
}
