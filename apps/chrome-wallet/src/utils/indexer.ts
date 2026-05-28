import type { NetworkId } from "../state/types";
import { walletStore } from "../state/wallet-store";
import { INDEXER_BASE_URL, DEFAULT_INDEXER_API_KEY } from "./explorer-config";

export type IndexerNetwork = "mainnet" | "testnet";

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
  [k: string]: unknown;
}

export interface BtcUtxo {
  txid: string;
  vout: number;
  value: number;
  status?: { confirmed: boolean; block_height?: number };
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

let cachedClient: ArchIndexerClient | null = null;
let cachedKey: string | null = null;

export async function getIndexer(): Promise<ArchIndexerClient> {
  const state = await walletStore.getState();
  const baseUrl = state.indexerBaseUrl || INDEXER_BASE_URL;
  const apiKey = state.indexerApiKey || DEFAULT_INDEXER_API_KEY;
  if (!apiKey) throw new MissingIndexerApiKeyError();
  const network = networkIdToIndexer(state.network);
  const cacheKey = `${baseUrl}|${apiKey}|${network}`;
  const blockedUntil = authFailureUntilByCacheKey.get(authCacheKey(baseUrl.replace(/\/+$/, ""), network, apiKey)) ?? 0;
  if (blockedUntil > Date.now()) throw new IndexerApiKeyRejectedError();
  if (cachedClient && cachedKey === cacheKey) return cachedClient;
  cachedClient = new ArchIndexerClient({ baseUrl, network, apiKey });
  cachedKey = cacheKey;
  return cachedClient;
}

export function invalidateIndexerCache(): void {
  cachedClient = null;
  cachedKey = null;
}
