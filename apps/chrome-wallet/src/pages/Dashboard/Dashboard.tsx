import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { useBtcUsdPrice } from "../../hooks/useBtcUsdPrice";
import { useWideMode } from "../../hooks/useWideMode";
import {
  getIndexer,
  isIndexerAuthError,
  isIndexerNotFoundError,
  type BtcAddressRuneBalance,
  type BtcInscriptionSummary,
  type IndexerClient
} from "../../utils/indexer";
import { formatRuneAmount, labelForRune } from "../../utils/runes-format";
import { InscriptionThumb } from "../../components/InscriptionThumb";
import { fetchWalletOverview } from "../../utils/wallet-overview";
import { reEncodeTaprootAddress } from "../../utils/addressNetwork";
import { deriveArchAccountAddress } from "../../utils/sdk";
import { formatBtc, formatBtcAmount, formatArchAmount, timestampToMs, formatBtcUsd } from "../../utils/format";
import { enrichIndexerTokens } from "../../utils/enrich-token";
import { resolveBtcTxTimestampMs } from "../../utils/btc-timestamps";
import { txHasRunestone } from "../../utils/btc-tx-classify";
import { summarizeArchTx, type ArchTxSummary } from "../../utils/arch-tx-summary";
import { normalizeArchStatus } from "../../utils/tx-status";
import {
  configureSwapEngineFromAppState,
} from "../../utils/swap-engine";
import ArchIcon from "../../components/ArchIcon";
import PortfolioHero from "../../components/PortfolioHero";
import { TokenIcon } from "../../components/TokenIcon";
import { ActivityRow, type ActivityRowTx } from "../../components/ActivityRow";

interface TokenBalance {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  uiAmount: string;
  image?: string;
}

type RecentTx = ActivityRowTx;

const DASHBOARD_FETCH_DEDUPE_MS = 30_000;

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

function btcLabel(direction: BtcTxDelta["direction"], isRune: boolean): string {
  if (isRune) {
    if (direction === "in") return "Received Rune";
    if (direction === "out") return "Sent Rune";
    return "Rune Transfer";
  }
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
  // Matches the 880px breakpoint that flips the dashboard into a
  // two-column grid (`html[data-mode="sidepanel"] .dashboard-grid`).
  // Above that width Portfolio sits beside Recent Activity, so the
  // section has room to surface more APL tokens inline before the
  // "+N more tokens" link kicks in. Below it we stay compact so the
  // popup (400px fixed) and narrow side panels don't grow a long
  // Portfolio column that pushes Recent Activity off-screen.
  const wideLayout = useWideMode(880);
  const inlineTokenCap = wideLayout ? 6 : 2;

  const [btcBalance, setBtcBalance] = useState<number | null>(null);
  const [btcPending, setBtcPending] = useState<number>(0);
  // Sats locked in inscription/rune/risky_rune outputs. Stays 0 on
  // mainnet during sync because the indexer omits protection fields
  // until it has the data.
  const [btcProtected, setBtcProtected] = useState<number>(0);
  // Aggregated rune balances for the active BTC address. Populated
  // by a best-effort fetch that runs alongside the wallet overview;
  // null = still loading, [] = no runes (hides the section).
  const [runes, setRunes] = useState<BtcAddressRuneBalance[] | null>(null);
  // Inscriptions held at the active BTC address. First page only
  // (server caps at 100); the dashboard card shows the first 6.
  const [inscriptions, setInscriptions] = useState<BtcInscriptionSummary[] | null>(null);
  // The indexer client used to fetch thumbnails. Stable reference
  // across renders so the InscriptionThumb effect doesn't refire
  // every time the dashboard re-renders for unrelated state.
  const [thumbIndexer, setThumbIndexer] = useState<IndexerClient | null>(null);
  const [archLamports, setArchLamports] = useState<number | null>(null);
  const [archAddress, setArchAddress] = useState<string>("");
  const [tokens, setTokens] = useState<TokenBalance[] | null>(null);
  const [recentTxs, setRecentTxs] = useState<RecentTx[] | null>(null);

  const [overviewLoaded, setOverviewLoaded] = useState(false);
  const [tokensLoaded, setTokensLoaded] = useState(false);
  const [txsLoaded, setTxsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [airdropLoading, setAirdropLoading] = useState(false);
  const inFlightFetchKeyRef = useRef<string | null>(null);
  const lastFetchRef = useRef<{ key: string; at: number } | null>(null);

  const markDashboardLoaded = useCallback(() => {
    setOverviewLoaded(true);
    setTokensLoaded(true);
    setTxsLoaded(true);
  }, []);

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
    if (!activeAccount) {
      setBtcBalance(0);
      setBtcPending(0);
      setBtcProtected(0);
      setRunes([]);
      setInscriptions([]);
      setArchLamports(0);
      setTokens([]);
      setRecentTxs([]);
      markDashboardLoaded();
      return;
    }
    const inputAddr = activeAccount.btcAddress;
    const archAddr =
      activeAccount.archAddress ||
      (activeAccount.publicKeyHex ? deriveArchAccountAddress(activeAccount.publicKeyHex) : "");
    const fetchKey = `${state.network}:${activeAccount.id}:${inputAddr}:${archAddr}`;
    const now = Date.now();
    if (!opts?.noCache) {
      if (inFlightFetchKeyRef.current === fetchKey) return;
      const lastFetch = lastFetchRef.current;
      if (lastFetch?.key === fetchKey && now - lastFetch.at < DASHBOARD_FETCH_DEDUPE_MS) {
        markDashboardLoaded();
        return;
      }
    }

    inFlightFetchKeyRef.current = fetchKey;
    setError(null);
    try {
      const indexer = await getIndexer();
      const btcAddrForNetwork = reEncodeTaprootAddress(inputAddr, state.network);

    const isTestnetNetwork = state.network === "testnet4";
    const archExplorerBase = isTestnetNetwork
      ? "https://explorer.arch.network/testnet/tx/"
      : "https://explorer.arch.network/mainnet/tx/";
    const btcExplorerBase = isTestnetNetwork
      ? "https://mempool.space/testnet4/tx/"
      : "https://mempool.space/tx/";

    // Fetch the raw account tokens once so the arch-tx classifier can
    // recognize CPI'd token movements into / out of the user's ATAs
    // (the source-of-truth signal for AMM swaps). Same response is
    // re-used by the token display flow below to avoid a duplicate
    // network call.
    const rawTokensPromise = indexer.getAccountTokens(archAddr || inputAddr).catch((e: any) => {
      if (!isIndexerAuthError(e) && !isIndexerNotFoundError(e)) {
        console.warn("[Dashboard] getAccountTokens failed:", e?.message);
      }
      return null;
    });

    const overviewPromise = fetchWalletOverview(indexer, {
      inputAddress: inputAddr,
      archAccountAddress: archAddr,
      btcAddress: btcAddrForNetwork,
      noCache: opts?.noCache
    }).then(async (overview) => {
      const btcSummary = overview?.btc?.summary;
      let confirmedSats = 0;
      let pendingSats = 0;
      // `protected_value` is only present when the indexer has
      // enriched UTXOs (testnet today, mainnet post-sync). Keep
      // separate from confirmed so the asset row can render an
      // explicit "locked" line when > 0 without affecting the
      // primary balance number.
      const protectedSats =
        typeof btcSummary?.protected_value === "number"
          ? btcSummary.protected_value
          : 0;

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
      setBtcProtected(protectedSats);
      setArchLamports(lamports);
      setArchAddress(archAddr);
      setOverviewLoaded(true);

      // Fetch aggregated rune balances in parallel with the rest of
      // the overview. Failure is silent (sets []) because rune
      // balances are an additive display surface -- if the indexer
      // hiccups, the user still sees BTC/Arch/tokens correctly. The
      // dashboard refresh interval will retry naturally.
      indexer
        .getBtcAddressRunes(btcAddrForNetwork)
        .then((r) => setRunes(Array.isArray(r?.balances) ? r.balances : []))
        .catch(() => setRunes([]));

      // Fetch the first page of inscriptions held at this address.
      // Same best-effort pattern: silent fallback to empty on error,
      // dashboard refresh retries. We stash the indexer instance
      // alongside the data so InscriptionThumb has a stable
      // reference for its content-fetch effect.
      setThumbIndexer(indexer);
      indexer
        .getBtcAddressInscriptions(btcAddrForNetwork)
        .then((r) =>
          setInscriptions(Array.isArray(r?.inscriptions) ? r.inscriptions : [])
        )
        .catch(() => setInscriptions([]));

      const btcTxItems: RecentTx[] = [];
      try {
        const btcTxs = await indexer.getBtcAddressTxs(btcAddrForNetwork);
        const rawList = (btcTxs ?? []).slice(0, 5);
        const fullTxs = await Promise.all(
          rawList.map(async (entry) => {
            // Mempool listings return minimal `{txid}` objects with
            // no `vin`/`vout`/`input`/`output`; the unconditional
            // "has txid -> use as-is" short-circuit left those rows
            // un-classifiable. Re-fetch when input/output arrays
            // are missing so rune detection + direction parsing
            // have something to work with.
            if (typeof entry === "object" && entry !== null && (entry as any).txid) {
              const obj = entry as any;
              const hasIO =
                Array.isArray(obj.vin) ||
                Array.isArray(obj.vout) ||
                Array.isArray(obj.input) ||
                Array.isArray(obj.output);
              if (hasIO) return obj;
              try {
                return await indexer.getBtcTransaction(obj.txid);
              } catch {
                return obj;
              }
            }
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
          const rawTimeMs = await resolveBtcTxTimestampMs(indexer, tx as Record<string, unknown>);
          // Clamp future timestamps. Same rationale as History.tsx:
          // a tx that has happened cannot legitimately display a
          // moment in the future, but indexer mempool views and
          // Bitcoin's loose block-time anti-malleability rules can
          // surface +N-minute drift.
          const nowMs = Date.now();
          const timeMs = rawTimeMs != null && rawTimeMs > nowMs ? nowMs : rawTimeMs;
          const { direction, sats } = parseRecentBtcTx(tx, btcAddrForNetwork);
          // Detect rune transfers locally (OP_RETURN OP_13). Avoids
          // the misleading "BTC Transaction" label and suppresses
          // the ~dust+fee net debit, which would otherwise show as
          // an irrelevant "BTC moved" amount on a rune row.
          const isRune = txHasRunestone(tx);
          const showAmount = !isRune;
          btcTxItems.push({
            txid,
            type: "btc",
            direction,
            sats: showAmount ? sats : 0,
            label: btcLabel(direction, isRune),
            amountLabel: showAmount ? buildBtcAmountLabel(direction, sats) : undefined,
            timestamp: timeMs != null ? String(timeMs) : undefined,
            status: isBtcTxConfirmed(tx) ? "confirmed" : "unconfirmed",
            explorerUrl: `${btcExplorerBase}${txid}`,
          });
        }
      } catch (e: any) {
        if (!isIndexerAuthError(e) && !isIndexerNotFoundError(e)) {
          console.warn("[Dashboard] getBtcAddressTxs failed:", e?.message);
        }
      }

      const rawArchTxs = overview?.arch?.recentTransactions?.transactions ?? [];
      if (overview?.arch?.recentTransactionsTimedOut) {
        console.warn("[Dashboard] Arch transactions timed out for", archAddr);
      }

      // Enrich each row with decoded instruction data + the full CPI
      // tree from /transactions/:txid. The tree is what lets the
      // summarizer recognize Token: Transfer instructions nested inside
      // custom programs (e.g. CLAMM swaps) — without it those rows fall
      // back to the generic "Custom Instruction" label. All five run in
      // parallel, capped to the same fast timeout as the rest of the
      // overview.
      const rawTokensResolved = await rawTokensPromise;
      const tokenAccountAddresses: string[] = [];
      for (const t of rawTokensResolved?.tokens ?? []) {
        const acct = (t as any)?.token_account_address;
        if (typeof acct === "string" && acct) tokenAccountAddresses.push(acct);
      }

      const detailedArchTxs = await Promise.all(
        rawArchTxs.slice(0, 5).map(async (tx: any) => {
          const [detail, tree] = await Promise.all([
            indexer.getTransactionDetail(tx.txid).catch(() => null),
            indexer.getTransactionTree(tx.txid).catch(() => null),
          ]);
          return {
            merged: { ...tx, ...((detail as Record<string, unknown>) ?? {}) },
            tree,
          };
        })
      );

      const archTxItems: RecentTx[] = detailedArchTxs
        .map(({ merged: tx, tree }): RecentTx => {
          const status = normalizeArchStatus(tx);
          const summary: ArchTxSummary = summarizeArchTx(
            { ...tx, status },
            archAddr,
            { tree, tokenAccounts: tokenAccountAddresses },
          );
          return {
            txid: tx.txid,
            type: "arch",
            direction: summary.direction,
            label: summary.label,
            amountLabel: summary.amountLabel,
            timestamp: tx.created_at,
            status,
            explorerUrl: `${archExplorerBase}${tx.txid}`,
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

    // Reuses the same response the arch-tx classifier already kicked off
    // above (rawTokensPromise). Avoids a duplicate /accounts/:addr/tokens
    // round-trip on every dashboard render.
    const tokensPromise = rawTokensPromise.then(async (res) => {
      try {
        const rawTokens = res?.tokens ?? [];
        const enriched = await enrichIndexerTokens(rawTokens, state.network, indexer);
        setTokens(enriched);
      } catch (e: any) {
        console.warn("[Dashboard] enrichIndexerTokens failed:", e?.message);
        setTokens([]);
      } finally {
        setTokensLoaded(true);
      }
    });

      await Promise.allSettled([overviewPromise, tokensPromise]);
    } catch (e: any) {
      console.warn("[Dashboard] load failed:", e?.message);
      setBtcBalance(0);
      setBtcPending(0);
      setBtcProtected(0);
      setRunes([]);
      setInscriptions([]);
      setArchLamports(0);
      setTokens([]);
      setRecentTxs([]);
      markDashboardLoaded();
    } finally {
      if (inFlightFetchKeyRef.current === fetchKey) {
        inFlightFetchKeyRef.current = null;
      }
      lastFetchRef.current = { key: fetchKey, at: Date.now() };
    }
  }, [activeAccount, markDashboardLoaded, state.network]);

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
      const POLL_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
      for (const delay of POLL_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delay));
        try {
          const fresh = await indexer.getAccountSummary(archAddress);
          const newLamports = fresh?.lamports_balance ?? (fresh as any)?.lamports ?? 0;
          if (newLamports !== prevLamports) {
            setArchLamports(newLamports);
            break;
          }
        } catch (pollErr) {
          if (isIndexerAuthError(pollErr)) throw pollErr;
          if (!isIndexerNotFoundError(pollErr)) {
            console.warn("[Dashboard] faucet balance poll failed:", (pollErr as any)?.message);
          }
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

  // The swap engine has its own NetworkConfig (token mints, program ids,
  // PropAMM deployment metadata). It needs the same network-id mapping
  // the Swap page uses, and the same `configureEngine` lifecycle, so we
  // re-apply on every state change here too. Cheap (module-state write)
  // and makes the engine usable across pages without per-route bootstrap.
  useEffect(() => {
    configureSwapEngineFromAppState(state);
  }, [state]);
  return (
    <>
      {/* Balance hero -- bleeds edge-to-edge of the main column in wide
          side panel mode. Lives outside .dashboard-shell so it isn't
          constrained by the inner max-width. */}
      {balancesReady ? (
        <PortfolioHero
          btcSats={btcBalance ?? 0}
          archLamports={archLamports ?? 0}
          tokens={tokens ?? []}
          btcUsd={btcUsd}
          archUsdFallback={null}
          refreshing={refreshing}
          onRefresh={handleRefresh}
        />
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
      <div className="dashboard-assets-col">

      {/* Unified holdings list. BTC -> Arch -> APL tokens -> runes ->
          Collectibles, all rendered as uniform rows inside a single
          card so the dashboard reads as one continuous holdings
          surface instead of a stack of per-asset-class boxes. Runes
          and Collectibles rows are omitted entirely when empty. */}
      <div className="section">
        <div className="section-title">Assets</div>
        <div className="card holdings">
          {/* Bitcoin -- the hero asset. Always shown, even for a
              brand-new BTC-only wallet. Carries the optional
              pending/locked breakdown. */}
          {balancesReady ? (
            <div className={`asset-row btc-row ${btcPending !== 0 ? "has-pending" : ""}`}>
              <div className="btc-row-head">
                <div className="asset-icon btc">₿</div>
                <div className="asset-info">
                  <div className="asset-name">Bitcoin</div>
                  <div className="asset-sub">BTC</div>
                </div>
                <div className="asset-balance-group">
                  <div className="asset-balance">{formatBtcAmount((btcBalance ?? 0) + btcPending)}</div>
                  {formatBtcUsd((btcBalance ?? 0) + btcPending, btcUsd) && (
                    <div className="asset-balance-usd">
                      {formatBtcUsd((btcBalance ?? 0) + btcPending, btcUsd)}
                    </div>
                  )}
                </div>
              </div>
              {(btcPending !== 0 || btcProtected > 0) && (
                <div className="btc-breakdown">
                  {btcPending !== 0 && (
                    <>
                      <div className="btc-breakdown-row">
                        <span className="btc-breakdown-label">Confirmed</span>
                        <span className="btc-breakdown-value">{formatBtcAmount(btcBalance ?? 0)}</span>
                      </div>
                      <div className="btc-breakdown-row">
                        <span className="btc-breakdown-label">Pending</span>
                        <span className={`btc-breakdown-value is-pending ${btcPending > 0 ? "incoming" : "outgoing"}`}>
                          {btcPending > 0 ? "+" : ""}{(btcPending / 1e8).toFixed(8)}
                        </span>
                      </div>
                    </>
                  )}
                  {btcProtected > 0 && (
                    <div
                      className="btc-breakdown-row is-locked"
                      title="Locked in Ordinal inscriptions and/or Rune balances. These outputs are excluded from BTC sends to prevent accidental loss."
                    >
                      <span className="btc-breakdown-label">Locked in inscriptions/runes</span>
                      <span className="btc-breakdown-value">{formatBtcAmount(btcProtected)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <SkeletonAssetRow />
          )}

          {/* Arch */}
          {balancesReady ? (
            <div className="asset-row">
              <div className="asset-icon arch"><ArchIcon size={18} /></div>
              <div className="asset-info">
                <div className="asset-name">Arch</div>
                <div className="asset-sub">ARCH</div>
              </div>
              <div className="asset-balance">{formatArchAmount(archLamports ?? 0)}</div>
            </div>
          ) : (
            <SkeletonAssetRow />
          )}

          {/* APL tokens (capped inline; overflow folds into a
              "+N more tokens" row that deep-links to the token list). */}
          {tokensLoaded
            ? (() => {
                const allTokens = tokens ?? [];
                const visible = allTokens.slice(0, inlineTokenCap);
                const hiddenCount = allTokens.length - visible.length;
                return (
                  <>
                    {visible.map((tk) => (
                      <div
                        className="asset-row clickable"
                        key={tk.mint}
                        onClick={() => navigate(`/tokens/${encodeURIComponent(tk.mint)}`)}
                      >
                        <TokenIcon
                          image={tk.image}
                          symbol={tk.symbol}
                          size={28}
                          wrapperClassName="asset-icon apl"
                        />
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
                          <ArchIcon size={24} color="var(--color-usd)" />
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

          {/* Runes -- Bitcoin-native fungible tokens. Each row
              deep-links into the rune send flow. Omitted for the
              common BTC-only wallet. */}
          {runes && runes.length > 0 &&
            runes.map((r) => (
              <div
                className="asset-row clickable"
                key={r.rune_id}
                onClick={() => navigate(`/rune/${encodeURIComponent(r.rune_id)}`)}
                title={`View ${r.spaced_name}`}
              >
                <div className="asset-icon rune">
                  {r.symbol && r.symbol.trim().length > 0 ? r.symbol : "\u00A4"}
                </div>
                <div className="asset-info">
                  <div className="asset-name">{r.spaced_name}</div>
                  <div className="asset-sub">Rune</div>
                </div>
                <div className="asset-balance" title={labelForRune(r)}>
                  {formatRuneAmount(r.amount, r.divisibility, { maxFractionDigits: 8 })}
                </div>
              </div>
            ))}

          {/* Collectibles -- single row summarizing inscriptions, with
              a thumbnail preview that taps through to the gallery.
              Omitted when the address holds no inscriptions. */}
          {thumbIndexer && inscriptions && inscriptions.length > 0 && (
            <div
              className="asset-row clickable collectibles-row"
              onClick={() => navigate("/collectibles")}
              title="View all collectibles"
            >
              <div className="asset-icon collectibles">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1.5" />
                  <rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <rect x="3" y="14" width="7" height="7" rx="1.5" />
                  <rect x="14" y="14" width="7" height="7" rx="1.5" />
                </svg>
              </div>
              <div className="asset-info">
                <div className="asset-name">Collectibles</div>
                <div className="asset-sub">
                  {inscriptions.length === 1
                    ? "1 inscription"
                    : `${inscriptions.length} inscriptions`}
                </div>
              </div>
              <div className="inscription-gallery-thumbs">
                {inscriptions.slice(0, 3).map((insc) => (
                  <InscriptionThumb
                    key={insc.id}
                    indexer={thumbIndexer}
                    summary={insc}
                    size={36}
                  />
                ))}
                {inscriptions.length > 3 && (
                  <div
                    className="inscription-gallery-more"
                    title={`+${inscriptions.length - 3} more inscriptions`}
                  >
                    +{inscriptions.length - 3}
                  </div>
                )}
              </div>
              <svg
                className="inscription-gallery-chevron"
                width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </div>
          )}
        </div>
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
                <ActivityRow
                  key={`${tx.type}-${tx.txid}`}
                  tx={tx}
                  variant="activity"
                  btcUsd={btcUsd}
                />
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
      </div>
      </div>
    </>
  );
}

