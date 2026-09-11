import type { NetworkId } from "../state/types";
import { walletStore } from "../state/wallet-store";
import {
  INDEXER_BASE_URL,
  DEFAULT_INDEXER_API_KEY,
  USE_DIRECT_INDEXER
} from "./explorer-config";
import { ArchHubIndexerClient } from "./hub-indexer";

export type IndexerNetwork = "mainnet" | "testnet";

/**
 * Public-surface type for the wallet's indexer client. Implemented
 * by both `ArchIndexerClient` (legacy direct path, behind
 * USE_DIRECT_INDEXER) and `ArchHubIndexerClient` (Hub-proxied path,
 * the default). Callers should import THIS type, not `ArchIndexerClient`,
 * so a future flag flip doesn't ripple across file signatures.
 *
 * TypeScript's structural typing means we don't need an explicit
 * `implements` clause on either class; the union of the two class
 * types gives callers exactly the methods both classes provide.
 */
export type IndexerClient = ArchIndexerClient | ArchHubIndexerClient;

export interface ArchIndexerClientOptions {
  baseUrl: string;
  network: IndexerNetwork;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface AccountSummary {
  address: string;
  address_hex?: string;
  lamports_balance?: number;
  transaction_count?: number;
  first_seen_at?: string | null;
  last_active_at?: string | null;
  [key: string]: unknown;
}

export interface AccountTokensResponse {
  tokens: Array<{
    mint_address: string;
    token_account_address?: string;
    amount?: string | number;
    decimals?: number | null;
    symbol?: string | null;
    name?: string | null;
    image?: string | null;
    ui_amount?: string;
    [key: string]: unknown;
  }>;
}

export interface AccountTransactionsResponse {
  transactions: Array<Record<string, unknown>>;
  total_count?: number;
  next_cursor?: string | null;
  page?: number | null;
  limit?: number | null;
}

export interface BtcAddressSummary {
  chain_stats?: {
    funded_txo_sum?: number;
    spent_txo_sum?: number;
    [k: string]: unknown;
  };
  mempool_stats?: {
    funded_txo_sum?: number;
    spent_txo_sum?: number;
    [k: string]: unknown;
  };
  outputs?: Array<Record<string, unknown>>;
  value?: number;

  /**
   * Sats sum across UTXOs that are NOT encumbered by inscriptions
   * or rune balances. Populated by the Titan-backed indexer on
   * testnet; may be absent on mainnet until sync completes -- in
   * that case callers should fall back to `value`.
   */
  spendable_value?: number;

  /**
   * Sats sum across UTXOs that ARE encumbered (inscriptions, runes,
   * or mempool-pending runes). Companion to `spendable_value`;
   * either both fields are present or both are absent.
   */
  protected_value?: number;

  [k: string]: unknown;
}

/**
 * Inscription metadata attached to an enriched UTXO. The Titan
 * indexer returns just `id` here -- richer fields (content_type,
 * satpoint) come from the per-inscription endpoint, not the UTXO
 * list. Keep this shape minimal so the wallet doesn't depend on
 * optional indexer fields landing on the UTXO list.
 */
export interface BtcUtxoInscription {
  id: string;
  [k: string]: unknown;
}

/**
 * Rune balance carried by a UTXO. Amount is a decimal string
 * because the underlying value is u128 (Number is unsafe above 2^53).
 * Callers MUST parse with `BigInt(amount)` before arithmetic.
 */
export interface BtcUtxoRune {
  rune_id: string;
  spaced_name?: string;
  amount: string;
  [k: string]: unknown;
}

/**
 * Aggregated rune balance for an address. `amount` is a decimal
 * string carrying the raw u128 minor-unit value; pass through
 * `formatRuneAmount(amount, divisibility)` for display.
 *
 * `symbol` is the rune's display glyph (Unicode), e.g. "\u29c9"
 * for UNCOMMON\u2022GOODS. May be empty for runes without a
 * configured symbol.
 */
export interface BtcAddressRuneBalance {
  rune_id: string;
  spaced_name: string;
  amount: string;
  divisibility: number;
  symbol?: string;
  [k: string]: unknown;
}

export interface BtcAddressRunesResponse {
  address: string;
  balances: BtcAddressRuneBalance[];
  [k: string]: unknown;
}

/**
 * A single rune event (mint / transfer / etch / burn) affecting an
 * address, from `GET /bitcoin/address/:address/rune-transactions`.
 * `delta` is a signed decimal string in minor units; positive means
 * inbound to the queried address. Pair with the rune's `divisibility`
 * (from the aggregated balances) to render a human amount.
 */
export interface BtcRuneTransaction {
  txid: string;
  block_height?: number;
  timestamp_ms?: number;
  kind: "etch" | "mint" | "transfer" | "burn";
  rune_id: string;
  spaced_name: string;
  delta: string;
  counterparty?: string;
  [k: string]: unknown;
}

export interface BtcAddressRuneTransactionsResponse {
  transactions: BtcRuneTransaction[];
  next_cursor: string | null;
  [k: string]: unknown;
}

/**
 * Rune metadata from `GET /bitcoin/runes/:rune`. Supplies are decimal
 * strings (u128 range); apply `divisibility` to render human amounts.
 * `mints_remaining` may be null/absent for unlimited or terms-free runes.
 */
export interface BtcRuneMetadata {
  rune_id: string;
  spaced_name: string;
  name?: string;
  number?: number;
  divisibility: number;
  symbol?: string;
  etching_txid?: string;
  etching_height?: number;
  premine?: string;
  max_supply?: string;
  minted?: string;
  burned?: string;
  circulating?: string;
  mints_remaining?: string | null;
  [k: string]: unknown;
}

/**
 * Per-inscription summary as returned by the per-address list.
 * Has the full set of fields needed to render a gallery thumbnail
 * (content_type, content_length, satpoint, id) without a second
 * per-inscription fetch.
 */
export interface BtcInscriptionSummary {
  id: string;
  number?: number;
  content_type: string;
  content_length: number;
  satpoint?: string;
  owner?: string;
  genesis_height?: number;
  genesis_fee?: number;
  [k: string]: unknown;
}

export interface BtcAddressInscriptionsResponse {
  inscriptions: BtcInscriptionSummary[];
  next_cursor: string | null;
  page_index?: number;
  page_size?: number;
  [k: string]: unknown;
}

/**
 * Result of fetching inscription binary content. `body` is the
 * raw bytes (suitable for wrapping in a Blob); `contentType` is
 * the MIME the wallet should use when rendering.
 */
export interface BtcInscriptionContent {
  body: ArrayBuffer;
  contentType: string;
  contentLength?: number;
}

export interface BtcUtxo {
  txid: string;
  vout: number;
  value: number;
  status?: { confirmed: boolean; block_height?: number };

  /**
   * Ordinal inscriptions present on this output. Field is omitted
   * (not empty array) on plain BTC outputs -- check with
   * `"inscriptions" in utxo` or use isProtectedUtxo() from
   * btc-protection.ts which handles both shapes.
   */
  inscriptions?: BtcUtxoInscription[];

  /** Confirmed rune balances on this output. */
  runes?: BtcUtxoRune[];

  /**
   * Mempool-pending rune balances on this output. Treat as
   * protected even though not yet confirmed -- including a
   * risky-runed UTXO in coin selection lets a front-runner
   * invalidate the user's send.
   */
  risky_runes?: BtcUtxoRune[];

  [k: string]: unknown;
}

export type BtcFeeEstimates = Record<string, number>;

export interface BtcBlockResponse {
  header?: {
    time?: number | string;
    [k: string]: unknown;
  };
  height?: number;
  [k: string]: unknown;
}

const AUTH_FAILURE_COOLDOWN_MS = 2 * 60_000;
const authFailureUntilByCacheKey = new Map<string, number>();

function authCacheKey(baseUrl: string, network: IndexerNetwork, apiKey: string): string {
  return `${baseUrl}|${network}|${apiKey}`;
}

export class ArchIndexerClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly authCacheKey: string;
  public readonly network: IndexerNetwork;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ArchIndexerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.network = opts.network;
    this.apiKey = opts.apiKey;
    this.authCacheKey = authCacheKey(this.baseUrl, this.network, this.apiKey);
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

  private url(path: string): string {
    const right = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}/${this.network}${right}`;
  }

  private headers(extra?: Record<string, string>): Headers {
    const h = new Headers(extra);
    if (this.apiKey) {
      h.set("authorization", `Bearer ${this.apiKey}`);
      h.set("x-api-key", this.apiKey);
    }
    return h;
  }

  private async getJson<T>(path: string): Promise<T> {
    this.assertAuthAvailable();
    const res = await this.fetchImpl(this.url(path), { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) this.rememberAuthFailure();
      throw new Error(`Indexer GET ${path} ${res.status} ${res.statusText}: ${text}`);
    }
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
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) this.rememberAuthFailure();
      throw new Error(`Indexer POST ${path} ${res.status} ${res.statusText}: ${text}`);
    }
    return (await res.json()) as T;
  }

  private async postText(path: string, body: string): Promise<string> {
    this.assertAuthAvailable();
    const headers = this.headers({ "content-type": "text/plain" });
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers,
      body
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      if (res.status === 401) this.rememberAuthFailure();
      throw new Error(`Indexer POST ${path} ${res.status} ${res.statusText}: ${t}`);
    }
    return await res.text();
  }

  // ── Arch Accounts ────────────────────────────────────────────────────────
  getAccountSummary(archAddress: string): Promise<AccountSummary> {
    return this.getJson(`/accounts/${encodeURIComponent(archAddress)}`);
  }

  getAccountTokens(archAddress: string): Promise<AccountTokensResponse> {
    return this.getJson(`/accounts/${encodeURIComponent(archAddress)}/tokens`);
  }

  getAccountTransactions(
    archAddress: string,
    limit = 50,
    page?: number
  ): Promise<AccountTransactionsResponse> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (page !== undefined) qs.set("page", String(page));
    return this.getJson(`/accounts/${encodeURIComponent(archAddress)}/transactions?${qs.toString()}`);
  }

  /**
   * Richer per-account transactions endpoint that returns chip labels
   * (`instructions: string[]`), `programs`, `status`, `fee_payer`, etc.
   * The legacy v1 path returns only minimal fields.
   */
  getAccountTransactionsV2(
    archAddress: string,
    limit = 50,
    page = 1
  ): Promise<AccountTransactionsResponse> {
    const qs = new URLSearchParams({ limit: String(limit), page: String(page) });
    return this.getJson(`/accounts/${encodeURIComponent(archAddress)}/transactions/v2?${qs.toString()}`);
  }

  // ── Arch Transactions ────────────────────────────────────────────────────
  getTransactionDetail(txid: string): Promise<Record<string, unknown>> {
    return this.getJson(`/transactions/${encodeURIComponent(txid)}`);
  }

  getTransactionInstructions(txid: string): Promise<Array<Record<string, unknown>>> {
    return this.getJson(`/transactions/${encodeURIComponent(txid)}/instructions`);
  }

  /**
   * Full instruction tree for a transaction, including CPI children.
   * Each node is shaped:
   *   { index, inner_index, depth, program_id_hex, program_id_base58,
   *     action, decoded, accounts, children: TreeNode[] }
   *
   * `/instructions` (singular) returns only the flat top-level rows;
   * use `/tree` whenever you need to inspect nested CPIs — e.g. AMM /
   * router swaps where the actual Token: Transfer happens inside a
   * custom-program top-level instruction.
   */
  getTransactionTree(txid: string): Promise<Array<Record<string, unknown>>> {
    return this.getJson(`/transactions/${encodeURIComponent(txid)}/tree`);
  }

  /**
   * Execution metadata for a transaction: status, logs, `has_cpi`,
   * `cpi_count`, compute-units, and the raw runtime tx. Useful as a
   * fallback when the tree endpoint doesn't decode a CPI but the logs
   * still witness "Program log: Instruction: Transfer".
   */
  getTransactionExecution(txid: string): Promise<Record<string, unknown>> {
    return this.getJson(`/transactions/${encodeURIComponent(txid)}/execution`);
  }

  // ── Tokens ───────────────────────────────────────────────────────────────
  getTokenList(params?: { q?: string; sort?: string; limit?: number }): Promise<unknown> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.sort) qs.set("sort", params.sort);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.getJson(`/tokens${suffix}`);
  }

  getTokenDetail(mint: string): Promise<unknown> {
    return this.getJson(`/tokens/${encodeURIComponent(mint)}`);
  }

  // ── Network ──────────────────────────────────────────────────────────────
  getNetworkStats(): Promise<unknown> {
    return this.getJson(`/network/stats`);
  }

  // ── Faucet ───────────────────────────────────────────────────────────────
  requestFaucetAirdrop(archAddress: string): Promise<unknown> {
    return this.postJson(`/faucet/airdrop`, { address: archAddress });
  }

  // ── Bitcoin ──────────────────────────────────────────────────────────────
  getBtcAddressSummary(btcAddress: string): Promise<BtcAddressSummary> {
    return this.getJson(`/bitcoin/address/${encodeURIComponent(btcAddress)}`);
  }

  getBtcAddressUtxos(btcAddress: string): Promise<BtcUtxo[]> {
    return this.getJson(`/bitcoin/address/${encodeURIComponent(btcAddress)}/utxo`);
  }

  getBtcAddressRunes(btcAddress: string): Promise<BtcAddressRunesResponse> {
    return this.getJson(`/bitcoin/address/${encodeURIComponent(btcAddress)}/runes`);
  }

  getBtcAddressRuneTransactions(
    btcAddress: string,
    params?: { limit?: number; cursor?: string; rune_id?: string }
  ): Promise<BtcAddressRuneTransactionsResponse> {
    const sp = new URLSearchParams();
    if (params?.limit != null) sp.set("limit", String(params.limit));
    if (params?.cursor) sp.set("cursor", params.cursor);
    if (params?.rune_id) sp.set("rune_id", params.rune_id);
    const suffix = sp.toString() ? `?${sp.toString()}` : "";
    return this.getJson(
      `/bitcoin/address/${encodeURIComponent(btcAddress)}/rune-transactions${suffix}`
    );
  }

  getBtcRune(rune: string): Promise<BtcRuneMetadata> {
    return this.getJson(`/bitcoin/runes/${encodeURIComponent(rune)}`);
  }

  getBtcAddressInscriptions(
    btcAddress: string,
    cursor?: string
  ): Promise<BtcAddressInscriptionsResponse> {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.getJson(
      `/bitcoin/address/${encodeURIComponent(btcAddress)}/inscriptions${suffix}`
    );
  }

  getBtcInscription(id: string): Promise<BtcInscriptionSummary> {
    return this.getJson(`/bitcoin/inscriptions/${encodeURIComponent(id)}`);
  }

  /**
   * Fetch inscription binary content with the wallet's auth path.
   * Returns ArrayBuffer + content-type so callers (Dashboard
   * thumbnail) can wrap in a Blob and create a single per-id
   * object URL. The Hub forwards ord's `cache-control: immutable`
   * header, so a service worker / disk cache will short-circuit
   * repeat loads of the same id without hitting the indexer.
   */
  async getBtcInscriptionContent(id: string): Promise<BtcInscriptionContent> {
    this.assertAuthAvailable();
    const url = this.url(`/bitcoin/inscriptions/${encodeURIComponent(id)}/content`);
    const res = await this.fetchImpl(url, { headers: this.headers() });
    if (res.status === 401 || res.status === 403) {
      this.rememberAuthFailure();
      throw new IndexerApiKeyRejectedError();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Indexer error ${res.status} ${res.statusText}: ${text}`);
    }
    const body = await res.arrayBuffer();
    const lenHeader = res.headers.get("content-length");
    return {
      body,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      contentLength: lenHeader ? Number(lenHeader) : undefined
    };
  }

  getBtcAddressTxs(btcAddress: string, afterTxid?: string): Promise<Array<Record<string, unknown> | string>> {
    const suffix = afterTxid ? `?after_txid=${encodeURIComponent(afterTxid)}` : "";
    return this.getJson(`/bitcoin/address/${encodeURIComponent(btcAddress)}/txs${suffix}`);
  }

  getBtcTransaction(txid: string): Promise<Record<string, unknown>> {
    return this.getJson(`/bitcoin/tx/${encodeURIComponent(txid)}`);
  }

  getBtcBlock(blockHash: string): Promise<BtcBlockResponse> {
    return this.getJson(`/bitcoin/block/${encodeURIComponent(blockHash)}`);
  }

  getBtcBlockHashAtHeight(height: number): Promise<string> {
    return this.getJson(`/bitcoin/block-height/${encodeURIComponent(String(height))}`);
  }

  getBtcFeeEstimates(): Promise<BtcFeeEstimates> {
    return this.getJson(`/bitcoin/fee-estimates`);
  }

  getBtcChainTip(): Promise<unknown> {
    return this.getJson(`/bitcoin/tip`);
  }

  /** Raw transaction broadcast. Body is a hex string; response is the txid. */
  broadcastBtc(rawTxHex: string): Promise<string> {
    return this.postText(`/bitcoin/tx`, rawTxHex);
  }

  // ── Search ───────────────────────────────────────────────────────────────
  search(q: string): Promise<unknown> {
    return this.getJson(`/search?q=${encodeURIComponent(q)}`);
  }

  // ── Legacy JSON-RPC compat ───────────────────────────────────────────────
  /**
   * Hit the indexer's `/api/v1/{network}/rpc` legacy compat endpoint. Used for
   * methods that aren't yet exposed as REST (e.g. `read_account_info` for
   * APL token metadata enrichment).
   */
  async rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    const headers = this.headers({ "content-type": "application/json" });
    const res = await this.fetchImpl(this.url(`/rpc`), {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Indexer RPC ${method} ${res.status} ${res.statusText}: ${text}`);
    }
    const json: any = await res.json();
    if (json?.error) {
      const msg = json.error.message ?? JSON.stringify(json.error);
      throw new Error(`Indexer RPC ${method} error: ${msg}`);
    }
    return json?.result as T;
  }
}

export class MissingIndexerApiKeyError extends Error {
  constructor() {
    super("Missing Indexer API key. Add one in Settings > Indexer API.");
    this.name = "MissingIndexerApiKeyError";
  }
}

export class IndexerApiKeyRejectedError extends Error {
  constructor() {
    super("Indexer rejected the API key. Update it in Settings > Indexer API.");
    this.name = "IndexerApiKeyRejectedError";
  }
}

export function isIndexerAuthError(err: unknown): boolean {
  if (err instanceof MissingIndexerApiKeyError || err instanceof IndexerApiKeyRejectedError) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  const lower = message.toLowerCase();
  return message.includes("401") || lower.includes("missing_credentials") || lower.includes("api key");
}

export function isIndexerNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return message.includes("404") || message.toLowerCase().includes("not found");
}

/**
 * Detect indexer rate-limit responses (HTTP 429). The error strings
 * thrown by getJson / postJson embed the status code, so a substring
 * match is the lowest-noise way to recognize the case across both
 * "Too Many Requests" and the indexer's own free-form bodies.
 *
 * Why callers care: rate-limit errors are not failures of the user's
 * setup -- the API key is valid, the network is up, the indexer just
 * said "slow down". UI should hint at the cause (often a shared /
 * leaked key) instead of silently rendering an empty list.
 */
export function isIndexerRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    message.includes("429") ||
    message.toLowerCase().includes("too many requests") ||
    message.toLowerCase().includes("rate limit")
  );
}

function networkIdToIndexer(n: NetworkId): IndexerNetwork {
  return n === "mainnet" ? "mainnet" : "testnet";
}

let cachedClient: IndexerClient | null = null;
let cachedKey: string | null = null;

/**
 * Return a cached indexer client. Routes through the Wallet Hub by
 * default; falls back to the legacy direct path when
 * `USE_DIRECT_INDEXER` is set at build time (the rollback escape
 * hatch; see explorer-config.ts).
 *
 * Cache key includes the routing mode so a build flip naturally
 * invalidates any in-flight cached client.
 */
export async function getIndexer(): Promise<IndexerClient> {
  const state = await walletStore.getState();
  const network = networkIdToIndexer(state.network);

  if (USE_DIRECT_INDEXER) {
    const baseUrl = state.indexerBaseUrl || INDEXER_BASE_URL;
    const apiKey = state.indexerApiKey || DEFAULT_INDEXER_API_KEY;
    if (!apiKey) throw new MissingIndexerApiKeyError();
    const cacheKey = `direct|${baseUrl}|${apiKey}|${network}`;
    const blockedUntil = authFailureUntilByCacheKey.get(authCacheKey(baseUrl.replace(/\/+$/, ""), network, apiKey)) ?? 0;
    if (blockedUntil > Date.now()) throw new IndexerApiKeyRejectedError();
    if (cachedClient && cachedKey === cacheKey) return cachedClient;
    cachedClient = new ArchIndexerClient({ baseUrl, network, apiKey });
    cachedKey = cacheKey;
    return cachedClient;
  }

  // Hub-routed path (default). Requires the wallet to have a Hub
  // base URL + Hub app key already configured -- which the
  // walletStore migration guarantees on first run, well before any
  // page can call getIndexer().
  const hubBaseUrl = state.hubBaseUrl;
  const hubApiKey = state.hubApiKey;
  if (!hubBaseUrl || !hubApiKey) {
    // Belt-and-suspenders: if for some reason hub config is missing
    // (e.g. user wiped state mid-session), raise the same auth-
    // missing error as the direct path. Callers already handle it
    // by sending the user to Settings.
    throw new MissingIndexerApiKeyError();
  }
  const installId = await walletStore.getInstallId();
  const cacheKey = `hub|${hubBaseUrl}|${hubApiKey}|${installId}|${network}`;
  if (cachedClient && cachedKey === cacheKey) return cachedClient;
  cachedClient = new ArchHubIndexerClient({
    hubBaseUrl,
    hubApiKey,
    installId,
    network
  });
  cachedKey = cacheKey;
  return cachedClient;
}

export function invalidateIndexerCache(): void {
  cachedClient = null;
  cachedKey = null;
}
