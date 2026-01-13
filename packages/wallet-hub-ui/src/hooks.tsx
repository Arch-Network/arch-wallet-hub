import { useCallback, useMemo, useState } from "react";
import { WalletHubClient } from "@arch/wallet-hub-sdk";

export function useWalletHubClient(params: { baseUrl: string; apiKey: string }) {
  return useMemo(() => new WalletHubClient(params), [params.baseUrl, params.apiKey]);
}

export function usePortfolio(params: { client: WalletHubClient; address: string | null }) {
  const [data, setData] = useState<unknown | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!params.address) return;
    setLoading(true);
    setError(null);
    try {
      const res = await params.client.getPortfolio(params.address);
      setData(res);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [params.client, params.address]);

  return { data, error, loading, refresh };
}
