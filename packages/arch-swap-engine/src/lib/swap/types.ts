import type { RuntimeTransaction, TokenSymbol } from "@/lib/arch/types";
import type { AmmType } from "@/lib/arch/types";

export type Token = {
  symbol: TokenSymbol;
  name: string;
  decimals: number;
  color: string;
};

/**
 * The shape every quote-producing path (PropAMM, CLAMM, aggregator) returns
 * and every UI consumer reads. `runtimeTx` is the executable transaction
 * the wallet will sign; `source` records which AMM produced it.
 */
export type Quote = {
  sellSymbol: TokenSymbol;
  buySymbol: TokenSymbol;
  sellAmount: number;
  buyAmount: number;
  rate: number;
  priceImpactPct: number;
  /** Unix ms timestamp at which the quote becomes stale. */
  expiresAt: number;
  runtimeTx: RuntimeTransaction;
  source: AmmType;
};

export const QUOTE_TTL_MS = 30_000;

/**
 * Placeholder x-only pubkey used for quote-only requests when no wallet is
 * connected. The resulting RuntimeTransaction is NOT executable — it exists
 * solely so the AMM contract returns real on-chain pricing for the UI.
 */
export const QUOTE_ONLY_PUBKEY = "00".repeat(32);

export function isQuoteFresh(quote: Quote | null, now = Date.now()): boolean {
  return !!quote && quote.expiresAt > now;
}

export function applySlippage(buyAmount: number, slippagePct: number): number {
  const tolerance = Math.max(0, slippagePct) / 100;
  return buyAmount * (1 - tolerance);
}

export type { ConnectionPhase, WalletIdentity, WalletState } from "@/lib/wallet/types";
