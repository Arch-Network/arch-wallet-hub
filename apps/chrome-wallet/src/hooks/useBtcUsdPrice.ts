import { useEffect, useState } from "react";
import { getBtcUsdPrice } from "../utils/btc-price";
import { useWallet } from "./useWallet";

interface UseBtcUsdPriceResult {
  /** USD price for 1 BTC, or null when unavailable or on testnet. */
  price: number | null;
  loading: boolean;
}

/**
 * Returns the current BTC -> USD price for displaying fiat equivalents.
 *
 * On testnet we deliberately return null so the UI does not annotate
 * test-coin balances with real-world dollar amounts.
 */
export function useBtcUsdPrice(): UseBtcUsdPriceResult {
  const { state } = useWallet();
  const [price, setPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (state.network !== "mainnet") {
      setPrice(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    getBtcUsdPrice()
      .then((result) => {
        if (cancelled) return;
        setPrice(result.price);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [state.network]);

  return { price, loading };
}
