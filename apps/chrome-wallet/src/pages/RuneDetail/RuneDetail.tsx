/**
 * Rune detail page.
 *
 * URL: /rune/:runeId (rune id is the canonical "block:tx" form)
 *
 * Parity with TokenDetail (the APL token screen): a hero with the
 * rune symbol + held balance, Send / Receive actions, a "Recent
 * Activity" feed sourced from `/bitcoin/address/:a/rune-transactions`
 * filtered to this rune, and an expandable Details block backed by
 * `/bitcoin/runes/:rune` (divisibility, supply, etching).
 *
 * Visual classes are reused verbatim from TokenDetail (`token-detail-*`)
 * so spacing/typography stay a single source of truth.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import {
  getIndexer,
  type BtcAddressRuneBalance,
  type BtcRuneMetadata,
} from "../../utils/indexer";
import { formatRuneAmount } from "../../utils/runes-format";
import { runeRowLabel, formatRuneDelta } from "../../utils/rune-history";
import { ActivityRow, type ActivityRowTx } from "../../components/ActivityRow";
import CopyButton from "../../components/CopyButton";
import ArchIcon from "../../components/ArchIcon";

function BackArrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ExplorerIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function ReceiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

interface RuneView {
  runeId: string;
  spacedName: string;
  symbol?: string;
  /** Held by the active address; null when not held (e.g. arrived from history). */
  balance: BtcAddressRuneBalance | null;
  /** Etching/supply metadata; null when the rune-metadata lookup failed. */
  meta: BtcRuneMetadata | null;
  /** Best known divisibility (balance preferred, then metadata). */
  divisibility?: number;
}

export default function RuneDetail() {
  const navigate = useNavigate();
  const { runeId: runeIdParam } = useParams<{ runeId: string }>();
  const runeId = decodeURIComponent(runeIdParam ?? "");
  const { activeAccount, state } = useWallet();

  const [view, setView] = useState<RuneView | null>(null);
  const [transactions, setTransactions] = useState<ActivityRowTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingTxs, setLoadingTxs] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const isTestnet = state.network === "testnet4";
  const btcExplorer = isTestnet
    ? "https://mempool.space/testnet4/tx/"
    : "https://mempool.space/tx/";

  useEffect(() => {
    if (!activeAccount?.btcAddress || !runeId) return;
    const btcAddress = activeAccount.btcAddress;

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const indexer = await getIndexer();
        // Balance + metadata in parallel; metadata is best-effort so a
        // missing/odd rune-metadata endpoint doesn't blank the page.
        const [balRes, metaRes] = await Promise.allSettled([
          indexer.getBtcAddressRunes(btcAddress),
          indexer.getBtcRune(runeId),
        ]);
        if (cancelled) return;

        const balance =
          balRes.status === "fulfilled"
            ? (balRes.value?.balances ?? []).find((b) => b.rune_id === runeId) ?? null
            : null;
        const meta = metaRes.status === "fulfilled" ? metaRes.value : null;

        if (!balance && !meta) {
          setError("Rune not found");
          setLoading(false);
          return;
        }

        const divisibility =
          balance?.divisibility ?? meta?.divisibility ?? undefined;

        setView({
          runeId,
          spacedName: balance?.spaced_name || meta?.spaced_name || runeId,
          symbol: balance?.symbol || meta?.symbol,
          balance,
          meta,
          divisibility,
        });
        setLoading(false);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || "Failed to load rune");
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeAccount?.btcAddress, runeId]);

  useEffect(() => {
    if (!activeAccount?.btcAddress || !runeId) {
      setTransactions([]);
      setLoadingTxs(false);
      return;
    }
    const btcAddress = activeAccount.btcAddress;
    const divisibility = view?.divisibility;

    let cancelled = false;
    (async () => {
      setLoadingTxs(true);
      try {
        const indexer = await getIndexer();
        const res = await indexer.getBtcAddressRuneTransactions(btcAddress, {
          rune_id: runeId,
          limit: 50,
        });
        if (cancelled) return;
        const rows: ActivityRowTx[] = (res?.transactions ?? []).map((rt) => {
          const amt = formatRuneDelta(rt.delta, divisibility);
          return {
            txid: rt.txid,
            type: "btc" as const,
            // No `sats` field -> the row won't apply a BTC->USD subtitle.
            direction: amt?.direction ?? "neutral",
            label: runeRowLabel(rt),
            amountLabel: amt?.amountLabel,
            timestamp: rt.timestamp_ms != null ? String(rt.timestamp_ms) : "",
            status: rt.block_height != null ? "confirmed" : "pending",
            explorerUrl: `${btcExplorer}${rt.txid}`,
          };
        });
        setTransactions(rows);
        setLoadingTxs(false);
      } catch {
        if (cancelled) return;
        setTransactions([]);
        setLoadingTxs(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeAccount?.btcAddress, runeId, view?.divisibility, btcExplorer]);

  const handleSend = useCallback(() => {
    navigate(`/send-rune/${encodeURIComponent(runeId)}`);
  }, [navigate, runeId]);

  const handleReceive = useCallback(() => {
    navigate("/receive");
  }, [navigate]);

  if (loading) {
    return (
      <>
        <div className="token-list-header">
          <button className="back-link" onClick={() => navigate("/")}>
            <BackArrow />
            <span>Back</span>
          </button>
          <div className="section-title" style={{ margin: 0 }}>Rune</div>
          <div style={{ width: 60 }} />
        </div>
        <div className="spinner-center">
          <div className="spinner" />
        </div>
      </>
    );
  }

  if (error || !view) {
    return (
      <>
        <div className="token-list-header">
          <button className="back-link" onClick={() => navigate("/")}>
            <BackArrow />
            <span>Back</span>
          </button>
          <div className="section-title" style={{ margin: 0 }}>Rune</div>
          <div style={{ width: 60 }} />
        </div>
        <div className="empty-state">
          <div className="empty-state-icon"><ArchIcon size={32} color="#7b68ee" /></div>
          <div>{error || "Rune not found"}</div>
        </div>
      </>
    );
  }

  const balanceLabel = view.balance
    ? formatRuneAmount(view.balance.amount, view.divisibility ?? 0)
    : "0";

  return (
    <>
      <div className="token-list-header">
        <button className="back-link" onClick={() => navigate("/")}>
          <BackArrow />
          <span>Back</span>
        </button>
        <div className="section-title" style={{ margin: 0 }}>{view.spacedName}</div>
        <div style={{ width: 60 }} />
      </div>

      <div className="token-detail-grid">
        <div className="token-detail-summary">
          <div className="token-detail-hero">
            <div
              className="token-detail-icon"
              style={{
                background: "rgba(193, 154, 91, 0.12)",
                border: "1px solid rgba(193, 154, 91, 0.25)",
                color: "var(--apl-gold)",
                fontSize: 24,
              }}
            >
              {view.symbol || "\u16A0"}
            </div>
            <div className="token-detail-name">{view.spacedName}</div>
            <div className="token-detail-balance">
              {balanceLabel}
              {view.symbol && <span className="token-detail-balance-symbol"> {view.symbol}</span>}
            </div>
          </div>

          <div className="token-detail-actions">
            <button className="btn btn-primary token-detail-action-btn" onClick={handleSend}>
              <SendIcon />
              <span>Send</span>
            </button>
            <button className="btn btn-secondary token-detail-action-btn" onClick={handleReceive}>
              <ReceiveIcon />
              <span>Receive</span>
            </button>
          </div>
        </div>

        <div className="token-detail-activity">
          <div className="section-title" style={{ marginTop: 0 }}>Recent Activity</div>
          <div className="card">
            {loadingTxs ? (
              <div className="spinner-center" style={{ padding: 12 }}>
                <div className="spinner" />
              </div>
            ) : transactions.length === 0 ? (
              <div style={{ padding: 12, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
                No rune activity yet
              </div>
            ) : (
              transactions.map((tx) => (
                <ActivityRow key={tx.txid} tx={tx} variant="compact" />
              ))
            )}
          </div>
        </div>

        <div className="token-detail-extras">
          <button
            className="token-detail-toggle"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
          >
            <span>Details</span>
            <span className={`token-detail-toggle-chevron${showDetails ? " open" : ""}`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
          </button>
          {showDetails && (
            <div className="card">
              <div className="token-detail-row">
                <span className="token-detail-label">Rune ID</span>
                <span className="token-detail-value">{view.runeId}</span>
                <CopyButton text={view.runeId} />
              </div>
              <div className="token-detail-row">
                <span className="token-detail-label">Divisibility</span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {view.divisibility ?? "—"}
                </span>
              </div>
              {view.symbol && (
                <div className="token-detail-row">
                  <span className="token-detail-label">Symbol</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{view.symbol}</span>
                </div>
              )}
              {view.meta?.circulating && (
                <div className="token-detail-row">
                  <span className="token-detail-label">Circulating</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {formatRuneAmount(view.meta.circulating, view.divisibility ?? 0)}
                  </span>
                </div>
              )}
              {view.meta?.max_supply && (
                <div className="token-detail-row">
                  <span className="token-detail-label">Max supply</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {formatRuneAmount(view.meta.max_supply, view.divisibility ?? 0)}
                  </span>
                </div>
              )}
              {view.meta?.etching_txid && (
                <div className="token-detail-row">
                  <span className="token-detail-label">Etching</span>
                  <a
                    className="token-detail-value"
                    href={`${btcExplorer}${view.meta.etching_txid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {view.meta.etching_txid}
                  </a>
                  <a
                    href={`${btcExplorer}${view.meta.etching_txid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View in explorer"
                    style={{ display: "flex", alignItems: "center", flexShrink: 0 }}
                  >
                    <ExplorerIcon />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
