/**
 * Inscription thumbnail with three rendering modes:
 *
 *   1. Image (PNG/JPEG/WEBP/GIF) -- fetched as blob, rendered via <img>
 *   2. Placeholder -- non-image content_type, shows a short label
 *      ("SVG", "HTML", "VID", etc) on a colored tile
 *   3. Error -- network/auth failure, shows a "?" tile with a tooltip
 *
 * The component does NOT navigate on click in this PR; the gallery
 * detail page is a planned follow-up. Tooltip shows the inscription
 * number + content_type so power users can still identify the asset.
 */
import { useEffect, useState } from "react";
import type { BtcInscriptionSummary, IndexerClient } from "../utils/indexer";
import {
  fetchInscriptionThumbUrl,
  isRenderableImage,
  shortLabelForType,
} from "../utils/inscription-thumb";

export interface InscriptionThumbProps {
  indexer: IndexerClient;
  summary: BtcInscriptionSummary;
  size?: number;
}

export function InscriptionThumb({ indexer, summary, size = 56 }: InscriptionThumbProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setErrored(false);

    if (!isRenderableImage(summary.content_type)) return;

    fetchInscriptionThumbUrl(
      indexer,
      summary.id,
      summary.content_type,
      summary.content_length
    )
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setErrored(true);
      });

    return () => {
      cancelled = true;
    };
  }, [indexer, summary.id, summary.content_type, summary.content_length]);

  const baseStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: 8,
    overflow: "hidden",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--surface-2, #1f2230)",
    color: "var(--text-muted, #9097a8)",
    fontFamily: "var(--font-mono, monospace)",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.3
  };

  // Number prefix on tooltip helps power users; falling back to the
  // truncated id when number is missing (genesis_height inscriptions
  // before ord's renumbering, etc).
  const title = summary.number
    ? `#${summary.number} \u00b7 ${summary.content_type}`
    : `${summary.id.slice(0, 8)}\u2026 \u00b7 ${summary.content_type}`;

  if (errored) {
    return (
      <div style={baseStyle} title={`${title} (failed to load)`}>?</div>
    );
  }
  if (src) {
    return (
      <img
        src={src}
        alt={title}
        title={title}
        style={{ ...baseStyle, objectFit: "cover" }}
        loading="lazy"
        // Crossfade on swap so the dashboard doesn't flicker when
        // the LRU cache hits or misses on re-render.
        draggable={false}
      />
    );
  }
  return (
    <div style={baseStyle} title={title}>
      {shortLabelForType(summary.content_type)}
    </div>
  );
}
