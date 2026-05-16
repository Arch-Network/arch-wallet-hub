import {
  ArchIndexerClient,
  type AccountSummary,
  type AccountTransactionsResponse,
  type BtcAddressSummary
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

interface CacheEntry {
  ts: number;
  ttl: number;
  data: WalletOverview;
}

const overviewCache = new Map<string, CacheEntry>();

function cacheKey(client: ArchIndexerClient, archAddress: string, btcAddress: string): string {
  return `${client.network}:${archAddress}:${btcAddress}`;
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<{ value: T; timedOut: false } | { value: null; timedOut: true }> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ value: null; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ value: null, timedOut: true }), ms);
  });
  return Promise.race([
    promise.then((value) => ({ value, timedOut: false as const })),
    timeout
  ]).finally(() => clearTimeout(timer));
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
  client: ArchIndexerClient,
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

  // Always attempt the transactions fetch. The previous version gated this
  // behind `transaction_count > 0`, but that field is missing from some
  // indexer responses (notably mainnet's account-summary right after the
  // service cold-starts), which caused the activity feed to look empty for
  // wallets that DO have history. The indexer handles "no txs" cheaply by
  // returning an empty array, so skipping the call doesn't actually save
  // anything meaningful.
  const archTxs = await raceWithTimeout(
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
    ttl: anyTimedOut ? PARTIAL_TTL_MS : FULL_TTL_MS,
    data
  });
  if (overviewCache.size > 200) {
    const oldest = overviewCache.keys().next().value;
    if (oldest) overviewCache.delete(oldest);
  }

  return data;
}
