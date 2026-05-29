/**
 * Resolve the per-network upstream indexer base URL.
 *
 * The upstream Arch indexer selects network by URL path:
 *   /api/v1/mainnet/...  → Bitcoin mainnet
 *   /api/v1/testnet/...  → Bitcoin testnet
 *   /api/v1/...          → legacy compat, defaults to TESTNET
 *
 * The Hub historically used a regex swap that ONLY worked when
 * the configured `INDEXER_BASE_URL` already contained a network
 * segment. When the base URL was `https://host/api/v1` (no segment),
 * the swap was a no-op and mainnet requests silently routed to
 * the testnet default. This function fixes that by always producing
 * the canonical `/{network}` path tail.
 *
 * Input shapes handled:
 *   https://host/api/v1
 *   https://host/api/v1/
 *   https://host/api/v1/mainnet
 *   https://host/api/v1/testnet
 *   https://host/api/v1/mainnet/   (trailing slash)
 *   https://host                   (no /api/v1, defensive)
 *
 * Output: always ends with `/{network}` (no trailing slash).
 */
export type ArchNetwork = "mainnet" | "testnet";

export function resolveNetworkBaseUrl(baseUrl: string, network: ArchNetwork): string {
  // URL constructor is the safest way to handle path manipulation
  // here -- avoids edge cases around port numbers, query strings,
  // and double-slashes that a hand-rolled regex would have to
  // get right.
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`resolveNetworkBaseUrl: invalid INDEXER_BASE_URL "${baseUrl}"`);
  }

  // Strip any existing network segment from the path. Tolerates both
  // mid-path (`/api/v1/testnet/`) and trailing (`/api/v1/testnet`)
  // shapes. Matches whole-segment only so a host like
  // `https://testnet.example.com` is left alone.
  let path = u.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(mainnet|testnet)(?=\/|$)/, "");

  // Append the target network. If the caller never set /api/v1
  // (e.g. they passed the bare origin), this still produces a
  // working URL because every upstream we proxy speaks /{network}
  // off the root.
  u.pathname = `${path}/${network}`;

  // toString() preserves scheme/host/port/search; pathname update
  // above is the only mutation we want.
  return u.toString().replace(/\/+$/, "");
}
