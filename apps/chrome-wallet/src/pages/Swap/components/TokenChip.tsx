/**
 * Token chip used by both the sell and receive cards. Renders the
 * token icon + ticker as a button; if `onClick` is provided the chip
 * is interactive and looks tappable, otherwise it's a read-only
 * presentation chip.
 *
 * The engine's `TokenInfo.icon` ships absolute paths like `/btc.png`
 * that arch-swap serves out of its `public/`. The wallet doesn't
 * ship those assets, so we attempt the `<img>` and fall back to the
 * wallet's native letter-glyph icon on load error. This keeps the
 * door open for shipping the real images later (drop them in
 * `public/` and they'll start rendering automatically) without
 * needing a coordinated UI change.
 */
import { useState, type ReactNode } from "react";

type TokenChipProps = {
  symbol: string;
  iconPath?: string;
  onClick?: () => void;
  ariaLabel?: string;
  trailing?: ReactNode;
};

function FallbackIcon({ symbol }: { symbol: string }) {
  // Match both the canonical engine symbol ("BTC") and the wallet's
  // wrapped-BTC display rename ("aBTC") so the chip styling and ₿
  // glyph stay consistent regardless of which label we surface.
  const isBtc = symbol === "BTC" || symbol === "aBTC";
  const isUsdc = symbol === "USDC";
  const cls = isBtc ? "btc" : isUsdc ? "usdc" : "apl";
  const glyph = isBtc ? "₿" : symbol.slice(0, 1).toUpperCase();
  return <span className={`asset-icon ${cls}`}>{glyph}</span>;
}

export function TokenChip({
  symbol,
  iconPath,
  onClick,
  ariaLabel,
  trailing,
}: TokenChipProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!iconPath && !imgFailed;

  const inner = (
    <>
      {showImg ? (
        <img
          className="swap-token-img"
          src={iconPath}
          alt=""
          onError={() => setImgFailed(true)}
        />
      ) : (
        <FallbackIcon symbol={symbol} />
      )}
      <span className="swap-token-symbol">{symbol}</span>
      {trailing}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className="swap-token-chip swap-token-chip-button"
        onClick={onClick}
        aria-label={ariaLabel ?? `Change token (currently ${symbol})`}
      >
        {inner}
      </button>
    );
  }
  return <span className="swap-token-chip">{inner}</span>;
}
