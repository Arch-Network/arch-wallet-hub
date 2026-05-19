/**
 * Popup-local hook that owns the swap quote lifecycle. Mirrors
 * arch-swap's `useSwapQuote` but is parameterized only on the wallet's
 * own state (no Zustand store, no React context). Returns the most
 * recent quote, refreshes on TTL, and debounces user input.
 */
import { useEffect, useRef, useState } from "react";

import {
  getAggregatedQuote,
  isQuoteFresh,
  QUOTE_ONLY_PUBKEY,
  QUOTE_TTL_MS,
  type NetworkConfig,
  type Quote,
  type TokenInfo,
  type WalletState,
} from "@arch/swap-engine";

const DEBOUNCE_MS = 350;
const REFRESH_INTERVAL_MS = QUOTE_TTL_MS;

export type UseSwapQuoteArgs = {
  config: NetworkConfig;
  wallet: WalletState;
  sellToken: TokenInfo;
  buyToken: TokenInfo;
  sellAmount: number;
  btcUsdPrice: number;
};

export type UseSwapQuoteResult = {
  quote: Quote | null;
  isLoading: boolean;
  isStale: boolean;
  error: string | null;
  refresh: () => void;
};

function tokenForRouter(token: TokenInfo) {
  return {
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    color: "",
  };
}

/**
 * Build the engine's WalletState shape from the inputs. When no
 * account is connected we still issue quotes -- the resulting tx
 * can't be executed but the rate display is useful.
 */
function walletForQuote(wallet: WalletState): WalletState {
  if (wallet.pubkeyXCoord) return wallet;
  return { ...wallet, pubkeyXCoord: QUOTE_ONLY_PUBKEY };
}

export function useSwapQuote({
  config,
  wallet,
  sellToken,
  buyToken,
  sellAmount,
  btcUsdPrice,
}: UseSwapQuoteArgs): UseSwapQuoteResult {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const requestIdRef = useRef(0);
  const previousPairRef = useRef<{
    sellSymbol: string;
    buySymbol: string;
  } | null>(null);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (sellAmount <= 0 || sellToken.symbol === buyToken.symbol) {
      setQuote(null);
      setError(null);
      setIsLoading(false);
      previousPairRef.current = {
        sellSymbol: sellToken.symbol,
        buySymbol: buyToken.symbol,
      };
      return;
    }

    setIsLoading(true);
    setError(null);

    const prev = previousPairRef.current;
    const pairChanged =
      prev !== null &&
      (prev.sellSymbol !== sellToken.symbol || prev.buySymbol !== buyToken.symbol);
    previousPairRef.current = {
      sellSymbol: sellToken.symbol,
      buySymbol: buyToken.symbol,
    };

    const timer = setTimeout(async () => {
      try {
        const next = await getAggregatedQuote(
          config,
          "aggregator",
          walletForQuote(wallet),
          tokenForRouter(sellToken),
          tokenForRouter(buyToken),
          sellAmount,
          { btcPrice: btcUsdPrice },
        );
        if (requestIdRef.current !== requestId) return;
        setQuote(next);
        setIsLoading(false);
      } catch (e) {
        if (requestIdRef.current !== requestId) return;
        setError(e instanceof Error ? e.message : "Failed to fetch quote");
        setQuote(null);
        setIsLoading(false);
      }
    }, pairChanged ? 0 : DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [
    config,
    wallet,
    sellToken,
    buyToken,
    sellAmount,
    btcUsdPrice,
    refreshKey,
  ]);

  useEffect(() => {
    if (!quote) return;
    const remaining = quote.expiresAt - Date.now();
    if (remaining <= 0) {
      setRefreshKey((k) => k + 1);
      return;
    }
    const timer = setTimeout(
      () => setRefreshKey((k) => k + 1),
      Math.min(remaining, REFRESH_INTERVAL_MS),
    );
    return () => clearTimeout(timer);
  }, [quote]);

  return {
    quote,
    isLoading,
    isStale: !!quote && !isQuoteFresh(quote),
    error,
    refresh: () => setRefreshKey((k) => k + 1),
  };
}
