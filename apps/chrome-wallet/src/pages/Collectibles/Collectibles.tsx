import EmptyStateArt from "../../components/EmptyStateArt";
/**
 * Collectibles -- unified Ordinals inscription and APL NFT gallery.
 *
 * Phase 3 of the IA rework. Gives inscriptions a real home (the
 * dashboard Ordinals row used to dead-end) with responsive depth:
 *
 *   - Popup / narrow panel: a compact thumbnail grid. Tapping a tile
 *     opens a full-bleed detail sheet over the grid.
 *   - Wide side panel (>=880px): a two-column layout -- the grid on
 *     the left, a persistent detail pane on the right that updates as
 *     you select tiles. The first inscription auto-selects so the
 *     pane is never empty.
 *
 * Data comes from the indexer's Bitcoin inscription and Arch token
 * endpoints. Each asset keeps its native detail and send flow.
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
import { resolveAccountAddresses } from "../../state/account-addresses";
import { InscriptionThumb } from "../../components/InscriptionThumb";
import BackBar from "../../components/BackBar";
import CopyButton from "../../components/CopyButton";
import { NftArtwork } from "../../components/NftArtwork";
import {
  enrichIndexerTokens,
  isRawNftCandidate,
  isNftToken,
  type EnrichedToken,
} from "../../utils/enrich-token";
import { AplCollectibleDetail } from "./AplCollectibleDetail";

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
  /** Navigate to the send-inscription flow for this inscription. */
  onSend: () => void;
}

type CollectibleSelection =
  | { kind: "inscription"; id: string }
  | { kind: "apl"; mint: string };

const NFT_BATCH_SIZE = 60;

function InscriptionDetail({ indexer, summary, btcExplorerBase, onSend }: DetailProps) {
  const txid = txidFromSatpoint(summary.satpoint);
  return (
    <div className="collectible-detail">
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

      <button className="btn btn-primary btn-full" onClick={onSend}>
        Send
      </button>
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
    </div>
  );
}

export default function Collectibles() {
  const { activeAccount, state } = useWallet();
  const navigate = useNavigate();
  const wide = useWideMode(880);

  const [indexer, setIndexer] = useState<IndexerClient | null>(null);
  const [items, setItems] = useState<BtcInscriptionSummary[] | null>(null);
  const [aplNfts, setAplNfts] = useState<EnrichedToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<CollectibleSelection | null>(null);
  const [visibleNftCount, setVisibleNftCount] = useState(NFT_BATCH_SIZE);
  // Inscriptions are held at the ordinals address.
  const ordinalsAddress = activeAccount
    ? resolveAccountAddresses(activeAccount, state.network).ordinals
    : null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activeAccount) {
        setItems([]);
        setAplNfts([]);
        return;
      }
      setError(null);
      setItems(null);
      setAplNfts(null);
      setSelection(null);
      setVisibleNftCount(NFT_BATCH_SIZE);
      try {
        const ix = await getIndexer();
        if (cancelled) return;
        setIndexer(ix);

        const archAddress = activeAccount.archAddress || activeAccount.btcAddress;
        const [inscriptionsResult, tokensResult] = await Promise.allSettled([
          ordinalsAddress ? ix.getBtcAddressInscriptions(ordinalsAddress) : { inscriptions: [] },
          ix.getAccountTokens(archAddress),
        ]);
        if (cancelled) return;

        const failures: unknown[] = [];
        if (inscriptionsResult.status === "fulfilled") {
          setItems(
            Array.isArray(inscriptionsResult.value?.inscriptions)
              ? inscriptionsResult.value.inscriptions
              : [],
          );
        } else {
          setItems([]);
          failures.push(inscriptionsResult.reason);
        }

        if (tokensResult.status === "fulfilled") {
          const candidates = (tokensResult.value?.tokens ?? []).filter(isRawNftCandidate);
          const enriched = await enrichIndexerTokens(
            candidates,
            state.network,
            ix,
          );
          if (cancelled) return;
          setAplNfts(enriched.filter(isNftToken));
        } else {
          setAplNfts([]);
          failures.push(tokensResult.reason);
        }

        if (failures.length === 2) {
          const authFailure = failures.some(isIndexerAuthError);
          setError(
            authFailure
              ? "Unlock the wallet to load your collectibles."
              : "Failed to load collectibles.",
          );
        } else if (failures.length === 1) {
          setError("Some collectibles could not be loaded.");
        }
      } catch (e: any) {
        if (cancelled) return;
        if (isIndexerNotFoundError(e)) {
          setItems([]);
          setAplNfts([]);
          return;
        }
        setError(
          isIndexerAuthError(e)
            ? "Unlock the wallet to load your collectibles."
            : e?.message || "Failed to load collectibles.",
        );
        setItems([]);
        setAplNfts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeAccount?.id, ordinalsAddress, state.network]);

  const btcExplorerBase =
    state.network === "testnet4"
      ? "https://mempool.space/testnet4/tx/"
      : "https://mempool.space/tx/";

  const selectedInscription =
    selection?.kind === "inscription"
      ? items?.find((item) => item.id === selection.id) ?? null
      : null;
  const selectedAplNft =
    selection?.kind === "apl"
      ? aplNfts?.find((token) => token.mint === selection.mint) ?? null
      : null;
  const totalItems = (items?.length ?? 0) + (aplNfts?.length ?? 0);
  const visibleAplNfts = aplNfts?.slice(0, visibleNftCount) ?? [];
  const showingCompactDetail = !wide && selection !== null;

  // Wide layout keeps a detail pane visible at all times, so default
  // the selection to the first collectible. Compact layout starts
  // with nothing selected (grid only) until the user taps a tile.
  useEffect(() => {
    if (!wide || selection || items == null || aplNfts == null) return;
    if (aplNfts.length > 0) {
      setSelection({ kind: "apl", mint: aplNfts[0]!.mint });
    } else if (items.length > 0) {
      setSelection({ kind: "inscription", id: items[0]!.id });
    }
  }, [wide, items, aplNfts, selection]);

  // In the compact layout a tapped tile replaces the grid with the
  // detail view, so the single sticky back control steps back to the
  // gallery first, then out to the dashboard -- one affordance, no
  // stacked "Back" + "Back to gallery" buttons.
  const onPageBack = () => {
    if (!wide && selection) {
      setSelection(null);
    } else {
      navigate("/dashboard");
    }
  };

  return (
    <div className={`collectibles-page${showingCompactDetail ? " is-detail" : ""}`}>
      <BackBar onBack={onPageBack} title="Collectibles" />
      {!showingCompactDetail && (
        <div className="page-header">
          <div className="page-subtitle">
            {items == null || aplNfts == null
              ? "Loading your collectibles\u2026"
              : totalItems === 0
                ? "Ordinal inscriptions and APL NFTs held by this wallet"
                : totalItems === 1
                  ? "1 collectible"
                  : `${totalItems} collectibles`}
          </div>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {renderBody()}
    </div>
  );

  function renderBody() {
    if (items == null || aplNfts == null) {
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

    if (totalItems === 0) {
      return (
        <div className="empty-state">
          <EmptyStateArt kind="collectibles" />
          <div className="empty-state-title">No collectibles yet</div>
          <div className="empty-state-sub">
            Ordinal inscriptions and APL NFTs received by this wallet will appear here.
          </div>
        </div>
      );
    }

    if (!indexer) return null;

    // Compact: tapping a tile swaps the grid out for the detail view
    // (with a back affordance) rather than overlaying -- avoids the
    // short-grid sizing trap and keeps one thing on screen at a time.
    if (!wide && selection) {
      return renderSelectedDetail();
    }

    const grid = (
      <div className="collectibles-gallery">
        <div className="collectibles-grid">
          {visibleAplNfts.map((token) => (
            <button
              className={`collectible-card ${selection?.kind === "apl" && selection.mint === token.mint ? "selected" : ""}`}
              key={`apl-${token.mint}`}
              onClick={() => setSelection({ kind: "apl", mint: token.mint })}
              title={token.name}
            >
              <div className="collectible-card-thumb">
                <NftArtwork
                  className="apl-collectible-thumb"
                  image={token.image}
                  name={token.name}
                  decorative
                />
              </div>
              <div className="collectible-card-label">{token.name}</div>
            </button>
          ))}
          {items.map((insc) => (
            <button
              className={`collectible-card ${selection?.kind === "inscription" && selection.id === insc.id ? "selected" : ""}`}
              key={insc.id}
              onClick={() => setSelection({ kind: "inscription", id: insc.id })}
              title={inscriptionTitle(insc)}
            >
              <div className="collectible-card-thumb">
                <InscriptionThumb indexer={indexer} summary={insc} size={wide ? 104 : 92} />
              </div>
              <div className="collectible-card-label">{inscriptionTitle(insc)}</div>
            </button>
          ))}
        </div>
        {aplNfts.length > visibleAplNfts.length && (
          <button
            type="button"
            className="btn btn-secondary collectibles-load-more"
            onClick={() => setVisibleNftCount((count) => count + NFT_BATCH_SIZE)}
          >
            Load {Math.min(NFT_BATCH_SIZE, aplNfts.length - visibleAplNfts.length)} more
          </button>
        )}
      </div>
    );

    if (!wide) return grid;

    // Wide: gallery + persistent detail pane side by side.
    return (
      <div className="collectibles-layout is-wide">
        {grid}
        {selection && (
          <aside className="collectibles-detail-pane">
            {renderSelectedDetail()}
          </aside>
        )}
      </div>
    );
  }

  function renderSelectedDetail() {
    if (selectedAplNft) {
      return (
        <AplCollectibleDetail
          token={selectedAplNft}
          onSend={() => navigate(`/send?asset=apl&mint=${encodeURIComponent(selectedAplNft.mint)}`)}
        />
      );
    }

    if (selectedInscription && indexer) {
      return (
        <InscriptionDetail
          indexer={indexer}
          summary={selectedInscription}
          btcExplorerBase={btcExplorerBase}
          onSend={() =>
            navigate(`/send-inscription/${encodeURIComponent(selectedInscription.id)}`)
          }
        />
      );
    }

    return null;
  }
}
