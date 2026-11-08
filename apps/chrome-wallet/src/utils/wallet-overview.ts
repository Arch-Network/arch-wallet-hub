import {
  type IndexerClient,
  type AccountSummary,
  type AccountTransactionsResponse,
  type BtcAddressSummary,
  isIndexerAuthError,
  isIndexerNotFoundError,
  isIndexerRateLimitError
} from "./indexer";

/**
 * A null `account` / `summary` / `recentTransactions` is only a genuinely
 * empty result when the matching `…TimedOut` is false and `…Error` is null
 * ("not found" counts as empty, not as an error). Otherwise the data is
 * unknown and must not be rendered as zero.
 */
export interface WalletOverview {
  inputAddress: string;
  archAccountAddress: string;
  btcAddress: string;
  arch: {
    account: AccountSummary | null;
    accountTimedOut: boolean;
    accountError: unknown;
    recentTransactions: AccountTransactionsResponse | null;
    recentTransactionsTimedOut: boolean;
    recentTransactionsError: unknown;
  };
  btc: {
    summary: BtcAddressSummary | null;
    summaryTimedOut: boolean;
    summaryError: unknown;
  };
}

const FAST_TIMEOUT_MS = 5_000;
const FULL_TTL_MS = 30_000;
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
    params.btcAddress
      ? raceWithTimeout(client.getBtcAddressSummary(params.btcAddress), FAST_TIMEOUT_MS)
      : Promise.resolve({ value: null, timedOut: false as const, error: null })
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
        if (isIndexerRateLimitError(err)) throw err;
        console.warn("[walletOverview] v2 transactions failed, falling back to v1:", err?.message);
        return client.getAccountTransactions(params.archAccountAddress, 10);
      }),
      FAST_TIMEOUT_MS
    );

  if (archTxs.timedOut) {
    console.warn("[walletOverview] Arch transactions timed out for", params.archAccountAddress);
  }

  const displayArchAddress = archAccountData?.address ?? params.archAccountAddress;
  const failure = (error: unknown) => (error && !isIndexerNotFoundError(error) ? error : null);
  const accountError = failure(archAccount.error);
  const recentTransactionsError = archAccountNotFound ? null : failure(archTxs.error);
  const summaryError = failure(btcSummary.error);

  const data: WalletOverview = {
    inputAddress: params.inputAddress,
    archAccountAddress: displayArchAddress,
    btcAddress: params.btcAddress,
    arch: {
      account: archAccountData,
      accountTimedOut: archAccount.timedOut,
      accountError,
      recentTransactions: archTxs.timedOut ? null : archTxs.value,
      recentTransactionsTimedOut: archTxs.timedOut,
      recentTransactionsError
    },
    btc: {
      summary: btcSummary.timedOut ? null : btcSummary.value,
      summaryTimedOut: btcSummary.timedOut,
      summaryError
    }
  };

  // Only cache what the indexer actually answered: a cached failure would
  // keep rendering as an empty wallet until the TTL ran out.
  const anyTimedOut = archAccount.timedOut || archTxs.timedOut || btcSummary.timedOut;
  if (anyTimedOut || accountError || recentTransactionsError || summaryError) return data;

  overviewCache.set(key, {
    ts: Date.now(),
    ttl: archAccountNotFound ? NOT_FOUND_TTL_MS : FULL_TTL_MS,
    data
  });
  if (overviewCache.size > 200) {
    const oldest = overviewCache.keys().next().value;
    if (oldest) overviewCache.delete(oldest);
  }

  return data;
}
