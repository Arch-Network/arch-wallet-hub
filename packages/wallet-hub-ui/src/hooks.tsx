import { useCallback, useMemo, useState } from "react";
import {
  WalletHubClient,
  type PortfolioResponse,
  type WalletHubClientOptions,
} from "@arch-network/wallet-hub-sdk";

/**
 * Build (and memoise) a `WalletHubClient`.
 *
 * Hardened in the 2026-05 pass:
 *   - `apiKey` is no longer required at the type level (it's a
 *     platform gate that may be injected by a reverse proxy; dApps
 *     using a session-token model never need to ship one).
 *   - `sessionToken` is the per-user credential. Callers should pass
 *     it (or call `client.setSessionToken`) after they obtain it
 *     from `verifyWalletLinkChallenge`.
 *   - The constructor enforces `https://` on `baseUrl` (except for
 *     localhost dev hosts), and the client itself adds a default
 *     request timeout.
 */
export function useWalletHubClient(
  params: Pick<
    WalletHubClientOptions,
    "baseUrl" | "apiKey" | "sessionToken" | "network" | "requestTimeoutMs"
  >,
) {
  return useMemo(
    () => new WalletHubClient(params),
    // Each piece of identity matters for memoisation.
    [params.baseUrl, params.apiKey, params.sessionToken, params.network, params.requestTimeoutMs],
  );
}

export function usePortfolio(params: {
  client: WalletHubClient;
  address: string | null;
}) {
  const [data, setData] = useState<PortfolioResponse | null>(null);
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
