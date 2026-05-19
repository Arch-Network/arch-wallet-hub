/**
 * Phase 2.1 - Unified fiat portfolio hero.
 *
 * Replaces the "Total ARCH Balance" hero with a single fiat figure
 * (`$X,XXX.XX`) plus a 24h delta. Falls back gracefully when prices
 * are unavailable (e.g. fresh dev install before CoinGecko caches
 * populate). When fiat is unknown we render the ARCH balance as the
 * primary value with a "USD price unavailable" sub-line, so the user
 * still sees something useful.
 */

import { useEffect, useState } from "react";
import { valuatePortfolio, type PortfolioValuation } from "../utils/prices";
import { formatArch } from "../utils/format";

interface PortfolioHeroProps {
  btcSats: number;
  archLamports: string | number;
  tokens: { mint: string; balance: number; decimals: number }[];
  /** BTC/USD rate already loaded by `useBtcUsdPrice`. We use it as a
   *  cheap shortcut to compute USD when CoinGecko also failed to load
   *  prices via the prices module. */
  btcUsd: number | null;
  /** Reserved for an out-of-band ARCH fallback price. */
  archUsdFallback: number | null;
  refreshing: boolean;
  onRefresh: () => void;
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatDelta(pct: number | null): { text: string; positive: boolean } | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  const positive = pct >= 0;
  return {
    text: `${positive ? "+" : ""}${pct.toFixed(2)}% (24h)`,
    positive,
  };
}

export default function PortfolioHero({
  btcSats,
  archLamports,
  tokens,
  btcUsd,
  refreshing,
  onRefresh,
}: PortfolioHeroProps) {
  const [valuation, setValuation] = useState<PortfolioValuation | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await valuatePortfolio({
          btcSats,
          archLamports,
          tokens: tokens.map((t) => ({ mint: t.mint, rawAmount: t.balance, decimals: t.decimals })),
        });
        if (!cancelled) setValuation(v);
      } catch {
        if (!cancelled) setValuation(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [btcSats, archLamports, tokens]);

  // Fall back to the legacy BTC-only USD shortcut when our prices
  // module produced 0 for BTC (e.g. CoinGecko offline) but we have a
  // local cached price already.
  let totalUsd = valuation?.totalUsd ?? 0;
  if (!totalUsd && btcUsd && btcSats > 0) {
    totalUsd = (btcSats / 1e8) * btcUsd;
  }

  const delta = valuation ? formatDelta(valuation.change24hPct) : null;
  const hasFiat = totalUsd > 0;

  return (
    <div className="balance-hero">
      <div className="balance-amount">
        {hasFiat ? formatUsd(totalUsd) : formatArch(archLamports ?? 0)}
      </div>
      <div className="balance-label" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
        {hasFiat ? "Portfolio value" : "Total ARCH Balance"}
        {delta && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: delta.positive ? "var(--success)" : "var(--danger)",
            }}
          >
            {delta.text}
          </span>
        )}
        <button
          className="refresh-btn"
          onClick={onRefresh}
          disabled={refreshing}
          title="Refresh balances"
        >
          <span className={refreshing ? "refresh-icon spinning" : "refresh-icon"}>?</span>
        </button>
      </div>
    </div>
  );
}
