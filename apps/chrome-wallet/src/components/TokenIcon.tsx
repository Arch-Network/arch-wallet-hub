/**
 * Resilient token-icon renderer used everywhere a token row is shown
 * (Dashboard portfolio, Tokens list, Token detail, Swap picker).
 *
 * Two rendering modes selected by whether `wrapperClassName` is set:
 *
 *   1. Wrapped (caller supplies `wrapperClassName`, e.g.
 *      `asset-icon apl`) — the wrapper's dimensions come from CSS
 *      (36px for `.asset-icon`). The component DOES NOT override
 *      those dimensions. The `size` prop sizes ONLY the inner
 *      content (image or fallback glyph), matching the existing
 *      visual convention where a 36px wrapper contains a 24–28px
 *      image. Earlier versions applied `size` to both the wrapper
 *      and the content, which left a dead ring around the image.
 *
 *   2. Standalone (no `wrapperClassName`) — the component sizes the
 *      wrapper itself to `size`, the image fills it, and the
 *      fallback glyph scales to ~60% of size. Used by the
 *      TokenDetail hero where there's no surrounding circle.
 *
 * The image vs. fallback decision is identical in both modes:
 *   - Image resolves → render image.
 *   - No `image` or `onError` fires → render `ArchIcon` glyph.
 * This guarantees we never show a browser broken-image placeholder
 * (the bug today's deploy reported on the first paint of USD Coin).
 */
import { useState } from "react";

import ArchIcon from "./ArchIcon";

type Props = {
  /** Image src (registry-supplied, indexer-supplied, or undefined). */
  image?: string | null;
  /** Token symbol — used as alt text + (in the future) for monogram fallbacks. */
  symbol: string;
  /** Inner content size in px (the image or fallback glyph). Wrapper
   *  dimensions come from `wrapperClassName`'s CSS in wrapped mode,
   *  or also fall back to `size` in standalone mode. Defaults to 28. */
  size?: number;
  /** When provided, the component renders inside this className and
   *  lets CSS own the wrapper geometry. When omitted, the component
   *  creates its own sized circle wrapper. */
  wrapperClassName?: string;
};

const DEFAULT_SIZE = 28;

export function TokenIcon({ image, symbol, size, wrapperClassName }: Props) {
  const dim = size ?? DEFAULT_SIZE;
  const [errored, setErrored] = useState(false);
  const showImage = !!image && !errored;

  // Wrapped mode: caller's CSS owns wrapper geometry; we only size content.
  //
  // The image is rendered slightly *larger* than its nominal `size` so it
  // visually fills the 36px `.asset-icon` wrapper to the same weight as
  // the legacy character glyphs (e.g. Bitcoin's `₿` at 17px font in the
  // same 36px circle reads as ~24px because of glyph metrics). The
  // fallback glyph follows the same proportions.
  if (wrapperClassName) {
    return (
      <div className={wrapperClassName}>
        {showImage ? (
          <img
            src={image as string}
            alt={symbol}
            width={dim}
            height={dim}
            style={{
              width: dim,
              height: dim,
              borderRadius: "50%",
              objectFit: "cover",
            }}
            onError={() => setErrored(true)}
          />
        ) : (
          <ArchIcon size={Math.round(dim * 0.85)} color="var(--color-usd)" />
        )}
      </div>
    );
  }

  // Standalone mode: component owns wrapper geometry too.
  const wrapperStyle: React.CSSProperties = {
    width: dim,
    height: dim,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
  };

  return (
    <span style={wrapperStyle}>
      {showImage ? (
        <img
          src={image as string}
          alt={symbol}
          width={dim}
          height={dim}
          style={{ width: dim, height: dim, objectFit: "cover" }}
          onError={() => setErrored(true)}
        />
      ) : (
        <ArchIcon size={Math.round(dim * 0.6)} color="var(--color-usd)" />
      )}
    </span>
  );
}
