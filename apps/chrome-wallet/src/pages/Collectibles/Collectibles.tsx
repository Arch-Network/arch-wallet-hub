/**
 * Collectibles -- the Ordinals/inscription gallery.
 *
 * Phase 3 of the IA rework. Gives inscriptions a real home (the
 * dashboard Ordinals row used to dead-end) with responsive depth:
 *
 *   - Popup / narrow panel: a compact thumbnail grid. Tapping a tile
 *     opens a full-bleed detail sheet over the grid.
 *   - Wide side panel (>=720px): a two-column layout -- the grid on
 *     the left, a persistent detail pane on the right that updates as
 *     you select tiles. The first inscription auto-selects so the
 *     pane is never empty.
 *
 * Data comes from the same indexer path the dashboard already uses
 * (`getBtcAddressInscriptions`). Sending an inscription lands in
 * Phase 4 (unified Send); for now the detail pane links out to the
 * transaction on the block explorer.
 */
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { useWideMode } from "../../hooks/useWideMode";
import {
  getIndexer,
  isIndexerAuthError,
  isIndexerNotFoundError,
  type BtcInscriptionSummary,
  type IndexerClient,
} from "../../utils/indexer";
import { reEncodeTaprootAddress } from "../../utils/addressNetwork";
import { InscriptionThumb } from "../../components/InscriptionThumb";
import CopyButton from "../../components/CopyButton";

function BackChevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function formatBytes(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "\u2014";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function truncMiddle(s: string, head = 10, tail = 8): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}\u2026${s.slice(-tail)}`;
}

/** Satpoint is `txid:vout:offset`; the txid is the leading field. */
function txidFromSatpoint(satpoint?: string): string | null {
  if (!satpoint) return null;
  const txid = satpoint.split(":")[0];
  return txid && /^[0-9a-f]{64}$/i.test(txid) ? txid : null;
}

function inscriptionTitle(insc: BtcInscriptionSummary): string {
  return typeof insc.number === "number"
    ? `Inscription #${insc.number}`
    : truncMiddle(insc.id);
}

interface DetailProps {
  indexer: IndexerClient;
  summary: BtcInscriptionSummary;
  btcExplorerBase: string;
  /** Present only in the compact sheet, where the user can dismiss. */
  onClose?: () => void;
}

function InscriptionDetail({ indexer, summary, btcExplorerBase, onClose }: DetailProps) {
  const txid = txidFromSatpoint(summary.satpoint);
  return (
    <div className="collectible-detail">
      {onClose && (
        <button className="back-link" onClick={onClose}>
          <BackChevron />
          Back to gallery
        </button>
      )}
      <div className="collectible-detail-preview">
        <InscriptionThumb indexer={indexer} summary={summary} size={200} />
      </div>
      <h2 className="collectible-detail-title">{inscriptionTitle(summary)}</h2>

      <div className="collectible-detail-fields">
        <div className="collectible-detail-row">
          <span className="collectible-detail-key">Type</span>
          <span className="collectible-detail-val">{summary.content_type || "\u2014"}</span>
        </div>
        <div className="collectible-detail-row">
          <span className="collectible-detail-key">Size</span>
          <span className="collectible-detail-val">{formatBytes(summary.content_length)}</span>
        </div>
        {typeof summary.genesis_height === "number" && (
          <div className="collectible-detail-row">
            <span className="collectible-detail-key">Genesis block</span>
            <span className="collectible-detail-val">{summary.genesis_height.toLocaleString()}</span>
          </div>
        )}
        {summary.satpoint && (
          <div className="collectible-detail-row">
            <span className="collectible-detail-key">Satpoint</span>
            <span className="collectible-detail-val mono">
              {truncMiddle(summary.satpoint, 12, 10)}
              <CopyButton text={summary.satpoint} />
            </span>
          </div>
        )}
        <div className="collectible-detail-row">
          <span className="collectible-detail-key">Inscription ID</span>
          <span className="collectible-detail-val mono">
            {truncMiddle(summary.id, 12, 10)}
            <CopyButton text={summary.id} />
          </span>
        </div>
      </div>

      {txid && (
        <a
          className="btn btn-secondary btn-full"
          href={`${btcExplorerBase}${txid}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View transaction
        </a>
      )}
      <div className="collectible-detail-hint">Sending inscriptions is coming soon.</div>
    </div>
  );
}

export default function Collectibles() {
  const { activeAccount, state } = useWallet();
  const navigate = useNavigate();
  const wide = useWideMode(720);

  const [indexer, setIndexer] = useState<IndexerClient | null>(null);
  const [items, setItems] = useState<BtcInscriptionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activeAccount) {
        setItems([]);
        return;
      }
      setError(null);
      setItems(null);
      try {
        const ix = await getIndexer();
        if (cancelled) return;
        setIndexer(ix);
        const addr = reEncodeTaprootAddress(activeAccount.btcAddress, state.network);
        const r = await ix.getBtcAddressInscriptions(addr);
        if (cancelled) return;
        setItems(Array.isArray(r?.inscriptions) ? r.inscriptions : []);
      } catch (e: any) {
        if (cancelled) return;
        if (isIndexerNotFoundError(e)) {
          setItems([]);
          return;
        }
        setError(
          isIndexerAuthError(e)
            ? "Unlock the wallet to load your inscriptions."
            : e?.message || "Failed to load inscriptions.",
        );
        setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeAccount?.id, activeAccount?.btcAddress, state.network]);

  const btcExplorerBase =
    state.network === "testnet4"
      ? "https://mempool.space/testnet4/tx/"
      : "https://mempool.space/tx/";

  const selected = items?.find((i) => i.id === selectedId) ?? null;

  // Wide layout keeps a detail pane visible at all times, so default
  // the selection to the first inscription. Compact layout starts
  // with nothing selected (grid only) until the user taps a tile.
  useEffect(() => {
    if (wide && items && items.length > 0 && !selectedId) {
      setSelectedId(items[0]!.id);
    }
  }, [wide, items, selectedId]);

  return (
    <div className="collectibles-page">
      <button className="back-link" onClick={() => navigate("/dashboard")}>
        <BackChevron />
        Back
      </button>
      <div className="page-header">
        <h2 className="page-title">Collectibles</h2>
        <div className="page-subtitle">
          {items == null
            ? "Loading your inscriptions\u2026"
            : items.length === 0
              ? "Ordinal inscriptions held by this wallet"
              : items.length === 1
                ? "1 inscription"
                : `${items.length} inscriptions`}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {renderBody()}
    </div>
  );

  function renderBody() {
    if (items == null) {
      return (
        <div className="collectibles-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div className="collectible-card" key={i}>
              <div className="collectible-card-thumb skeleton" />
            </div>
          ))}
        </div>
      );
    }

    if (items.length === 0) {
      return (
        <div className="empty-state">
          <div className="empty-state-icon">{"\uD83D\uDDBC\uFE0F"}</div>
          <div className="empty-state-title">No inscriptions yet</div>
          <div className="empty-state-sub">
            Ordinals received by this wallet will appear here.
          </div>
        </div>
      );
    }

    if (!indexer) return null;

    // Compact: tapping a tile swaps the grid out for the detail view
    // (with a back affordance) rather than overlaying -- avoids the
    // short-grid sizing trap and keeps one thing on screen at a time.
    if (!wide && selected) {
      return (
        <InscriptionDetail
          indexer={indexer}
          summary={selected}
          btcExplorerBase={btcExplorerBase}
          onClose={() => setSelectedId(null)}
        />
      );
    }

    const grid = (
      <div className="collectibles-grid">
        {items.map((insc) => (
          <button
            className={`collectible-card ${selectedId === insc.id ? "selected" : ""}`}
            key={insc.id}
            onClick={() => setSelectedId(insc.id)}
            title={inscriptionTitle(insc)}
          >
            <div className="collectible-card-thumb">
              <InscriptionThumb indexer={indexer} summary={insc} size={wide ? 104 : 92} />
            </div>
            <div className="collectible-card-label">{inscriptionTitle(insc)}</div>
          </button>
        ))}
      </div>
    );

    if (!wide) return grid;

    // Wide: gallery + persistent detail pane side by side.
    return (
      <div className="collectibles-layout is-wide">
        {grid}
        {selected && (
          <aside className="collectibles-detail-pane">
            <InscriptionDetail
              indexer={indexer}
              summary={selected}
              btcExplorerBase={btcExplorerBase}
            />
          </aside>
        )}
      </div>
    );
  }
}
