import {
  type IndexerClient,
  type AccountSummary,
  type AccountTransactionsResponse,
  type BtcAddressSummary,
  isIndexerAuthError,
  isIndexerNotFoundError
} from "./indexer";

export interface WalletOverview {
  inputAddress: string;
  archAccountAddress: string;
  btcAddress: string;
  arch: {
    account: AccountSummary | null;
    accountTimedOut: boolean;
    recentTransactions: AccountTransactionsResponse | null;
    recentTransactionsTimedOut: boolean;
  };
  btc: {
    summary: BtcAddressSummary | null;
    summaryTimedOut: boolean;
  };
}

const FAST_TIMEOUT_MS = 5_000;
const FULL_TTL_MS = 30_000;
const PARTIAL_TTL_MS = 10_000;
const NOT_FOUND_TTL_MS = 2 * 60_000;

interface CacheEntry {
  ts: number;
  ttl: number;
  data: WalletOverview;
}

const overviewCache = new Map<string, CacheEntry>();

function cacheKey(client: IndexerClient, archAddress: string, btcAddress: string): string {
  return `${client.network}:${archAddress}:${btcAddress}`;
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<
  | { value: T; timedOut: false; error: null }
  | { value: null; timedOut: true; error: null }
  | { value: null; timedOut: false; error: unknown }
> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ value: null; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ value: null, timedOut: true }), ms);
  });
  return Promise.race([
    promise
      .then((value) => ({ value, timedOut: false as const, error: null }))
      .catch((error) => ({ value: null, timedOut: false as const, error })),
    timeout
  ])
    .then((result) => (
      "error" in result ? result : { ...result, error: null }
    ))
    .finally(() => clearTimeout(timer));
}

export interface FetchOverviewParams {
  inputAddress: string;
  archAccountAddress: string;
  btcAddress: string;
  noCache?: boolean;
}

/**
 * Compose the wallet dashboard view from the Indexer. Mirrors the old Hub
 * /wallet/:address/overview route's shape (and caching) but runs in-extension.
 */
export async function fetchWalletOverview(
  client: IndexerClient,
  params: FetchOverviewParams
): Promise<WalletOverview> {
  const key = cacheKey(client, params.archAccountAddress, params.btcAddress);

  if (!params.noCache) {
    const hit = overviewCache.get(key);
    if (hit && Date.now() - hit.ts < hit.ttl) {
      return hit.data;
    }
  }

  const [archAccount, btcSummary] = await Promise.all([
    raceWithTimeout(client.getAccountSummary(params.archAccountAddress), FAST_TIMEOUT_MS),
    raceWithTimeout(client.getBtcAddressSummary(params.btcAddress), FAST_TIMEOUT_MS)
  ]);

  const archAccountData = archAccount.timedOut ? null : archAccount.value;
  const archAccountNotFound =
    !archAccount.timedOut && archAccount.error && isIndexerNotFoundError(archAccount.error);
  const archAuthFailed =
    !archAccount.timedOut && archAccount.error && isIndexerAuthError(archAccount.error);

  // Attempt the transactions fetch unless Explorer has explicitly said the
  // account doesn't exist yet. Fresh wallets can take a while to appear after
  // funding; hammering transaction endpoints during that window just creates
  // doomed 404/401 noise without improving UX.
  //
  // The previous version gated this
  // behind `transaction_count > 0`, but that field is missing from some
  // indexer responses (notably mainnet's account-summary right after the
  // service cold-starts), which caused the activity feed to look empty for
  // wallets that DO have history. The indexer handles "no txs" cheaply by
  // returning an empty array, so skipping the call doesn't actually save
  // anything meaningful.
  const archTxs = archAccountNotFound || archAuthFailed
    ? { value: null, timedOut: false as const, error: archAccount.error }
    : await raceWithTimeout(
      // v2 returns the chip labels + decoded summaries we need to render
      // a richer activity feed on the dashboard. Falls back to v1 on error.
      client.getAccountTransactionsV2(params.archAccountAddress, 10).catch((err) => {
        console.warn("[walletOverview] v2 transactions failed, falling back to v1:", err?.message);
        return client.getAccountTransactions(params.archAccountAddress, 10);
      }),
      FAST_TIMEOUT_MS
    );

  if (archTxs.timedOut) {
    console.warn("[walletOverview] Arch transactions timed out for", params.archAccountAddress);
  }

  const displayArchAddress = archAccountData?.address ?? params.archAccountAddress;

  const data: WalletOverview = {
    inputAddress: params.inputAddress,
    archAccountAddress: displayArchAddress,
    btcAddress: params.btcAddress,
    arch: {
      account: archAccountData,
      accountTimedOut: archAccount.timedOut,
      recentTransactions: archTxs.timedOut ? null : archTxs.value,
      recentTransactionsTimedOut: archTxs.timedOut
    },
    btc: {
      summary: btcSummary.timedOut ? null : btcSummary.value,
      summaryTimedOut: btcSummary.timedOut
    }
  };

  const anyTimedOut = archAccount.timedOut || archTxs.timedOut || btcSummary.timedOut;
  overviewCache.set(key, {
    ts: Date.now(),
    ttl: archAccountNotFound ? NOT_FOUND_TTL_MS : anyTimedOut ? PARTIAL_TTL_MS : FULL_TTL_MS,
    data
  });
  if (overviewCache.size > 200) {
    const oldest = overviewCache.keys().next().value;
    if (oldest) overviewCache.delete(oldest);
  }

  return data;
}
