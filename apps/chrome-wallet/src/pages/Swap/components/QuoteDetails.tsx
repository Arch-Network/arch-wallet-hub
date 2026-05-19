/**
 * Quote details row stack. Shows rate, price impact, min received
 * (after slippage), and the AMM source the quote came from. Collapses
 * to nothing when there's no quote to summarize.
 */
import type { AmmType } from "@arch/swap-engine";

import { applySlippage } from "@arch/swap-engine";

import { formatSwapBalance } from "../../../utils/format";

type Props = {
  sellSymbol: string;
  buySymbol: string;
  sellAmount: number;
  buyAmount: number;
  slippagePct: number;
  source: AmmType;
};

function formatRate(sellSymbol: string, buySymbol: string, rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "—";
  // High-magnitude rates (e.g. BTC/USDC ≈ 110,000) get 2 decimals
  // and thousands separators; sub-100 rates get 6 decimals so we
  // don't drop precision on USDC/BTC inverses.
  const decimals = rate >= 100 ? 2 : 6;
  const display = rate.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `1 ${sellSymbol} ≈ ${display} ${buySymbol}`;
}

function formatBuyAmount(amount: number, symbol: string): string {
  if (!Number.isFinite(amount) || amount <= 0) return "—";
  return formatSwapBalance(amount, symbol);
}

function sourceLabel(source: AmmType): string {
  switch (source) {
    case "propamm":
      return "PropAMM";
    case "clamm":
      return "CLAMM";
    default:
      return source;
  }
}

export function QuoteDetails({
  sellSymbol,
  buySymbol,
  sellAmount,
  buyAmount,
  slippagePct,
  source,
}: Props) {
  if (sellAmount <= 0 || buyAmount <= 0) return null;
  const rate = buyAmount / sellAmount;
  const minReceived = applySlippage(buyAmount, slippagePct);

  return (
    <div className="swap-details">
      <div className="swap-detail-row">
        <span>Rate</span>
        <span className="swap-detail-value">{formatRate(sellSymbol, buySymbol, rate)}</span>
      </div>
      <div className="swap-detail-row">
        <span>Min received ({slippagePct.toFixed(2)}% slip)</span>
        <span className="swap-detail-value">{formatBuyAmount(minReceived, buySymbol)}</span>
      </div>
      <div className="swap-detail-row">
        <span>Source</span>
        <span className="swap-detail-value">{sourceLabel(source)}</span>
      </div>
    </div>
  );
}
