/**
 * Home-screen headline. The wording comes from `describePortfolio`:
 * test assets are shown in BTC with no dollar value, an unreadable
 * balance says so (with Retry) instead of showing zero, and priced
 * totals name what they leave out. No 24h change is shown.
 */

import { useEffect, useState } from "react";
import { valuatePortfolio, type PortfolioValuation } from "../utils/prices";
import { describePortfolio, type HoldingsSnapshot } from "../utils/portfolio-summary";

interface PortfolioHeroProps {
  snapshot: HoldingsSnapshot;
  tokens: { mint: string; balance: number; decimals: number }[];
  refreshing: boolean;
  onRefresh: () => void;
}

export default function PortfolioHero({ snapshot, tokens, refreshing, onRefresh }: PortfolioHeroProps) {
  const [valuation, setValuation] = useState<PortfolioValuation | null>(null);
  const { network, btcSats, archLamports } = snapshot;

  useEffect(() => {
    if (network !== "mainnet") {
      setValuation(null);
      return;
    }
    let cancelled = false;
    valuatePortfolio({
      btcSats: btcSats ?? 0,
      archLamports: archLamports ?? 0,
      tokens: tokens.map((t) => ({ mint: t.mint, rawAmount: t.balance, decimals: t.decimals })),
      network,
    }).then(
      (v) => !cancelled && setValuation(v),
      () => !cancelled && setValuation(null),
    );
    return () => {
      cancelled = true;
    };
  }, [btcSats, archLamports, tokens, network]);

  const headline = describePortfolio(snapshot, valuation);

  return (
    <div
      className="balance-hero"
      data-tone={headline.tone}
      data-unit={headline.primary.startsWith("$") ? "usd" : "text"}
    >
      <div className="balance-amount">{headline.primary}</div>
      <div className="balance-label">
        <span>{headline.secondary}</span>
        <button
          className="refresh-btn"
          onClick={onRefresh}
          disabled={refreshing}
          title="Refresh balances"
          aria-label="Refresh balances"
        >
          <span className={refreshing ? "refresh-icon spinning" : "refresh-icon"}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ display: "block" }}
            >
              <path d="M21 12a9 9 0 1 1-3.6-7.2" />
              <polyline points="21 4 21 10 15 10" />
            </svg>
          </span>
        </button>
      </div>
      {headline.notes.length > 0 && (
        <ul className="balance-notes">
          {headline.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {headline.tone === "unavailable" && (
        <button className="btn btn-secondary btn-sm balance-retry" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}
