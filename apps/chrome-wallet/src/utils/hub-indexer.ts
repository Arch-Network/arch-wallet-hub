/**
 * Hub-backed indexer client.
 *
 * Implements the same public surface as `ArchIndexerClient` but
 * routes every call through the Wallet Hub's `/v1/indexer/*` proxy
 * routes (defined in services/wallet-hub-api/src/routes/indexer.ts).
 * The privileged indexer API key stays on the Hub; the wallet
 * authenticates as an app via `x-api-key` (already present in
 * `state.hubApiKey`) and identifies its installation via
 * `x-arch-install-id` for per-installation rate limiting.
 *
 * Why a parallel class rather than a constructor flag on
 * `ArchIndexerClient`:
 *   - URL layouts differ: direct mode is `{base}/{network}/{path}`;
 *     Hub mode is `{hubBase}/v1/indexer/{arch|btc}/{path}` with
 *     network in the `x-network` header.
 *   - Auth differs: direct mode sends `Authorization: Bearer <indexerKey>`
 *     and `x-api-key: <indexerKey>`; Hub mode sends `x-api-key: <hubKey>`.
 *   - Error envelope differs: direct mode surfaces upstream's status
 *     code verbatim; Hub mode surfaces a uniform 502 envelope on
 *     upstream failure (intentional; see PR #17). We want both error
 *     shapes to feed `isIndexerRateLimitError` / `isIndexerAuthError`
 *     unchanged, which is easier with separate code paths than a fat
 *     `if (mode === "hub")` branch on every method.
 *
 * Public surface is intentionally identical to `ArchIndexerClient`
 * so `getIndexer()` can return either class behind the same
 * interface and the rest of the wallet doesn't change.
 */
import type { NetworkId } from "../state/types";
import type {
  AccountSummary,
  AccountTokensResponse,
  AccountTransactionsResponse,
  BtcAddressSummary,
  BtcBlockResponse,
  BtcFeeEstimates,
  BtcUtxo,
  IndexerNetwork
} from "./indexer";
import { IndexerApiKeyRejectedError } from "./indexer";

export interface ArchHubIndexerClientOptions {
  /** Hub base URL, e.g. `https://hub.arch.network`. No trailing slash. */
  hubBaseUrl: string;
  /** Hub app API key (the wallet's per-app x-api-key value). */
  hubApiKey: string;
  /** Stable per-installation UUID from `chrome.storage.local`. */
  installId: string;
  /** `mainnet` | `testnet`; forwarded to the Hub via x-network. */
  network: IndexerNetwork;
  fetchImpl?: typeof fetch;
}

const AUTH_FAILURE_COOLDOWN_MS = 2 * 60_000;
const authFailureUntilByCacheKey = new Map<string, number>();

function authCacheKey(hubBaseUrl: string, network: IndexerNetwork, hubApiKey: string): string {
  return `${hubBaseUrl}|${network}|${hubApiKey}`;
}

export class ArchHubIndexerClient {
  private readonly hubBaseUrl: string;
  private readonly hubApiKey: string;
  private readonly installId: string;
  public readonly network: IndexerNetwork;
  private readonly authCacheKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ArchHubIndexerClientOptions) {
    this.hubBaseUrl = opts.hubBaseUrl.replace(/\/+$/, "");
    this.hubApiKey = opts.hubApiKey;
    this.installId = opts.installId;
    this.network = opts.network;
    this.authCacheKey = authCacheKey(this.hubBaseUrl, this.network, this.hubApiKey);
    const f = (opts.fetchImpl ?? fetch) as any;
    this.fetchImpl = typeof f?.bind === "function" ? f.bind(globalThis) : f;
  }

  private assertAuthAvailable(): void {
    const blockedUntil = authFailureUntilByCacheKey.get(this.authCacheKey) ?? 0;
    if (blockedUntil > Date.now()) {
      throw new IndexerApiKeyRejectedError();
    }
  }

  private rememberAuthFailure(): void {
    authFailureUntilByCacheKey.set(this.authCacheKey, Date.now() + AUTH_FAILURE_COOLDOWN_MS);
  }

  /**
   * Compose a Hub URL. Adds the `/v1/indexer/` prefix; never includes
   * the network in the path (`x-network` header carries that).
   */
  private url(path: string): string {
    const right = path.startsWith("/") ? path : `/${path}`;
    return `${this.hubBaseUrl}/v1/indexer${right}`;
  }

  private headers(extra?: Record<string, string>): Headers {
    const h = new Headers(extra);
    h.set("x-api-key", this.hubApiKey);
    h.set("x-network", this.network);
    h.set("x-arch-install-id", this.installId);
    return h;
  }

  /**
   * Convert a non-2xx Hub response into a thrown Error whose message
   * remains compatible with `isIndexerRateLimitError`,
   * `isIndexerAuthError`, and `isIndexerNotFoundError` in indexer.ts.
   *
   * The Hub maps upstream throttles (429s, "rate limit" bodies) to a
   * 502 BadGateway envelope on purpose -- the wallet itself ISN'T
   * being throttled, the Hub upstream is. We surface the original
   * message text so the existing detector functions still match
   * (they search for "429" / "rate limit" / "too many requests" /
   * "401" substrings).
   */
  private async raiseForStatus(path: string, res: Response, method: string): Promise<never> {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) this.rememberAuthFailure();
    // 502 envelope from the Hub: try to surface upstream message text
    // so callers can still detect rate-limit / not-found semantics.
    let upstreamMsg = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.message && typeof parsed.message === "string") {
        upstreamMsg = parsed.message;
      }
    } catch {
      // Body wasn't JSON; keep raw text.
    }
    throw new Error(
      `Hub indexer ${method} ${path} ${res.status} ${res.statusText}: ${upstreamMsg}`
    );
  }

  private async getJson<T>(path: string): Promise<T> {
    this.assertAuthAvailable();
    const res = await this.fetchImpl(this.url(path), { headers: this.headers() });
    if (!res.ok) await this.raiseForStatus(path, res, "GET");
    return (await res.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    this.assertAuthAvailable();
    const headers = this.headers({ "content-type": "application/json" });
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) await this.raiseForStatus(path, res, "POST");
    return (await res.json()) as T;
  }

  // ── Arch Accounts ────────────────────────────────────────────────────────
  getAccountSummary(archAddress: string): Promise<AccountSummary> {
    return this.getJson(`/arch/accounts/${encodeURIComponent(archAddress)}`);
  }

  getAccountTokens(archAddress: string): Promise<AccountTokensResponse> {
    return this.getJson(`/arch/accounts/${encodeURIComponent(archAddress)}/tokens`);
  }

  getAccountTransactions(
    archAddress: string,
    limit = 50,
    page?: number
  ): Promise<AccountTransactionsResponse> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (page !== undefined) qs.set("page", String(page));
    return this.getJson(`/arch/accounts/${encodeURIComponent(archAddress)}/transactions?${qs.toString()}`);
  }

  getAccountTransactionsV2(
    archAddress: string,
    limit = 50,
    page = 1
  ): Promise<AccountTransactionsResponse> {
    const qs = new URLSearchParams({ limit: String(limit), page: String(page) });
    return this.getJson(`/arch/accounts/${encodeURIComponent(archAddress)}/transactions/v2?${qs.toString()}`);
  }

  // ── Arch Transactions ────────────────────────────────────────────────────
  getTransactionDetail(txid: string): Promise<Record<string, unknown>> {
    return this.getJson(`/arch/transactions/${encodeURIComponent(txid)}`);
  }

  getTransactionInstructions(txid: string): Promise<Array<Record<string, unknown>>> {
    return this.getJson(`/arch/transactions/${encodeURIComponent(txid)}/instructions`);
  }

  getTransactionTree(txid: string): Promise<Array<Record<string, unknown>>> {
    return this.getJson(`/arch/transactions/${encodeURIComponent(txid)}/tree`);
  }

  getTransactionExecution(txid: string): Promise<Record<string, unknown>> {
    return this.getJson(`/arch/transactions/${encodeURIComponent(txid)}/execution`);
  }

  // ── Tokens ───────────────────────────────────────────────────────────────
  getTokenList(params?: { q?: string; sort?: string; limit?: number }): Promise<unknown> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.sort) qs.set("sort", params.sort);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.getJson(`/arch/tokens${suffix}`);
  }

  getTokenDetail(mint: string): Promise<unknown> {
    return this.getJson(`/arch/tokens/${encodeURIComponent(mint)}`);
  }

  // ── Network ──────────────────────────────────────────────────────────────
  getNetworkStats(): Promise<unknown> {
    return this.getJson(`/arch/network/stats`);
  }

  // ── Search ───────────────────────────────────────────────────────────────
  search(q: string): Promise<unknown> {
    return this.getJson(`/arch/search?q=${encodeURIComponent(q)}`);
  }

  // ── Faucet ───────────────────────────────────────────────────────────────
  requestFaucetAirdrop(archAddress: string): Promise<unknown> {
    return this.postJson(`/arch/faucet/airdrop`, { address: archAddress });
  }

  // ── Bitcoin ──────────────────────────────────────────────────────────────
  getBtcAddressSummary(btcAddress: string): Promise<BtcAddressSummary> {
    return this.getJson(`/btc/address/${encodeURIComponent(btcAddress)}`);
  }

  getBtcAddressUtxos(btcAddress: string): Promise<BtcUtxo[]> {
    return this.getJson(`/btc/address/${encodeURIComponent(btcAddress)}/utxo`);
  }

  getBtcAddressTxs(btcAddress: string, afterTxid?: string): Promise<Array<Record<string, unknown> | string>> {
    const suffix = afterTxid ? `?after_txid=${encodeURIComponent(afterTxid)}` : "";
    return this.getJson(`/btc/address/${encodeURIComponent(btcAddress)}/txs${suffix}`);
  }

  getBtcTransaction(txid: string): Promise<Record<string, unknown>> {
    return this.getJson(`/btc/tx/${encodeURIComponent(txid)}`);
  }

  getBtcBlock(blockHash: string): Promise<BtcBlockResponse> {
    return this.getJson(`/btc/block/${encodeURIComponent(blockHash)}`);
  }

  getBtcBlockHashAtHeight(height: number): Promise<string> {
    return this.getJson(`/btc/block-height/${encodeURIComponent(String(height))}`);
  }

  getBtcFeeEstimates(): Promise<BtcFeeEstimates> {
    return this.getJson(`/btc/fee-estimates`);
  }

  getBtcChainTip(): Promise<unknown> {
    return this.getJson(`/btc/tip`);
  }

  /**
   * BTC broadcast. The Hub's `POST /v1/indexer/btc/tx` accepts a JSON
   * body (`{ rawTxHex }`) -- different from the upstream's text/plain
   * convention because the Hub adds audit logging that wants
   * structured input. Response shape is `{ txid: string }`.
   */
  async broadcastBtc(rawTxHex: string): Promise<string> {
    const result = await this.postJson<{ txid: string }>(`/btc/tx`, { rawTxHex });
    return result.txid;
  }

  // ── Legacy JSON-RPC compat ───────────────────────────────────────────────
  /**
   * Forwards `{ method, params }` to the Hub's `/arch/rpc` proxy. The
   * Hub server-side wraps in the JSON-RPC envelope and unwraps
   * `.result`; this method receives the result directly (or a thrown
   * error on JSON-RPC `.error`).
   */
  async rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    const result = await this.postJson<T>(`/arch/rpc`, { method, params });
    return result;
  }
}

export function networkIdToIndexer(n: NetworkId): IndexerNetwork {
  return n === "mainnet" ? "mainnet" : "testnet";
}
