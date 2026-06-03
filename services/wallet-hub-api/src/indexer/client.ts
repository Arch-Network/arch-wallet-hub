import type { FastifyInstance } from "fastify";

export type IndexerClient = {
  getAccountSummary(address: string): Promise<unknown>;
  getAccountTokens(address: string): Promise<unknown>;
  getAccountTransactions(address: string, limit?: number, page?: number): Promise<unknown>;
  getAccountTransactionsV2(address: string, limit?: number, page?: number): Promise<unknown>;
  getTransactions(params: {
    address?: string;
    limit?: number;
    cursor?: string;
    offset?: number;
    confirmed_after?: string;
    confirmed_before?: string;
    include_total?: boolean;
  }): Promise<unknown>;
  getTransactionDetail(txid: string): Promise<unknown>;
  getTransactionExecution(txid: string): Promise<unknown>;
  getTransactionInstructions(txid: string): Promise<unknown>;
  getTransactionTree(txid: string): Promise<unknown>;

  getTokens(params?: { q?: string; sort?: string; limit?: number }): Promise<unknown>;
  getTokenDetail(mint: string): Promise<unknown>;
  getTokenLeaderboard(): Promise<unknown>;

  getNetworkStats(): Promise<unknown>;

  search(q: string): Promise<unknown>;

  requestFaucetAirdrop(address: string): Promise<unknown>;

  getBtcAddressSummary(address: string): Promise<unknown>;
  getBtcAddressUtxos(address: string): Promise<unknown>;
  getBtcAddressTxs(address: string, afterTxid?: string): Promise<unknown>;
  /**
   * Aggregated rune balances for a Bitcoin address. Response shape:
   * `{ address, balances: [{ amount, divisibility, rune_id, spaced_name, symbol }] }`.
   * `amount` is a decimal-string (u128). Empty `balances` for addresses
   * with no runes.
   */
  getBtcAddressRunes(address: string): Promise<unknown>;

  /**
   * Inscriptions held at a Bitcoin address (paginated). Cursor is
   * an opaque base64 string from a previous response's `next_cursor`.
   * Page size is fixed at 100 by ord upstream.
   */
  getBtcAddressInscriptions(address: string, cursor?: string): Promise<unknown>;

  /**
   * Address-scoped rune transfer history (paginated). Response shape:
   * `{ transactions: [{ txid, block_height, timestamp_ms, kind, rune_id,
   * spaced_name, delta, counterparty? }], next_cursor }`. `delta` is a
   * signed decimal string (positive = inbound to the address). Used by
   * the wallet's History tab to label rune mint/transfer/etch/burn rows.
   */
  getBtcAddressRuneTransactions(
    address: string,
    params?: { limit?: number; cursor?: string; rune_id?: string },
  ): Promise<unknown>;

  /**
   * Per-inscription metadata: id, number, content_type, satpoint,
   * content_length, genesis_height, owner, etc. Used by the gallery
   * detail view; the per-address list response already carries
   * enough to render thumbnails.
   */
  getBtcInscription(id: string): Promise<unknown>;

  /**
   * Raw inscription content (binary). Returns the upstream body
   * with its content-type and cache-control headers preserved so
   * the Hub can stream it to the wallet without losing browser
   * cacheability. Body may be up to several MB; callers should
   * decide their own size cap.
   */
  getBtcInscriptionContent(id: string): Promise<{
    body: ArrayBuffer;
    contentType: string;
    contentLength?: number;
    cacheControl?: string;
  }>;
  getBtcTransaction(txid: string): Promise<unknown>;
  getBtcTransactionStatus(txid: string): Promise<unknown>;
  broadcastBtcTransaction(rawTxHex: string): Promise<unknown>;
  getBtcFeeEstimates(): Promise<unknown>;
  getBtcChainTip(): Promise<unknown>;
  getBtcBlock(blockHash: string): Promise<unknown>;
  getBtcBlockHashAtHeight(height: number): Promise<unknown>;

  /**
   * Forward a JSON-RPC call to the indexer's `/rpc` compat endpoint
   * and return ONLY the `.result` field. The wrapper handles the
   * JSON-RPC envelope (`jsonrpc`, `id`) and turns `.error` responses
   * into thrown errors -- callers see plain `.result` on success
   * and a thrown Error on failure, the same shape every other
   * method on this client uses.
   *
   * Used by the wallet today for things like `read_account_info`
   * (APL token metadata enrichment) that aren't exposed as REST.
   */
  archRpc(method: string, params: unknown): Promise<unknown>;
};

export function createIndexerClient(server: FastifyInstance, baseUrlOverride?: string): IndexerClient | null {
  const baseUrl = baseUrlOverride ?? server.config.INDEXER_BASE_URL;
  if (!baseUrl) return null;
  const baseUrlValue = baseUrl;
  const apiKey = server.config.INDEXER_API_KEY;
  const timeoutMs = (server.config as any).INDEXER_TIMEOUT_MS ?? 30_000;

  function joinUrl(path: string) {
    const left = baseUrlValue.endsWith("/") ? baseUrlValue.slice(0, -1) : baseUrlValue;
    const right = path.startsWith("/") ? path : `/${path}`;
    return `${left}${right}`;
  }

  function headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) {
      h["authorization"] = `Bearer ${apiKey}`;
      h["x-api-key"] = apiKey;
    }
    return h;
  }

  function abortSignal() {
    return typeof (AbortSignal as any)?.timeout === "function"
      ? (AbortSignal as any).timeout(timeoutMs)
      : undefined;
  }

  async function getJson(path: string) {
    const url = joinUrl(path);
    let res: Response;
    try {
      res = await fetch(url, { headers: headers(), signal: abortSignal() });
    } catch (err: any) {
      const isAbort =
        err?.name === "AbortError" ||
        String(err?.message ?? "").toLowerCase().includes("abort");
      if (isAbort) throw new Error(`Indexer request timeout after ${timeoutMs}ms: ${url}`);
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Indexer error ${res.status} ${res.statusText} (${url}): ${text}`);
    }
    return await res.json();
  }

  async function postJson(path: string, body: unknown) {
    const url = joinUrl(path);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
        signal: abortSignal()
      });
    } catch (err: any) {
      const isAbort =
        err?.name === "AbortError" ||
        String(err?.message ?? "").toLowerCase().includes("abort");
      if (isAbort) throw new Error(`Indexer request timeout after ${timeoutMs}ms: ${url}`);
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Indexer error ${res.status} ${res.statusText} (${url}): ${text}`);
    }
    return await res.json();
  }

  async function postText(path: string, text: string): Promise<string> {
    const url = joinUrl(path);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...headers(), "content-type": "text/plain" },
        body: text,
        signal: abortSignal()
      });
    } catch (err: any) {
      const isAbort =
        err?.name === "AbortError" ||
        String(err?.message ?? "").toLowerCase().includes("abort");
      if (isAbort) throw new Error(`Indexer request timeout after ${timeoutMs}ms: ${url}`);
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Indexer error ${res.status} ${res.statusText} (${url}): ${body}`);
    }
    return await res.text();
  }

  function qs(params: Record<string, string | number | boolean | undefined>): string {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "";
    const sp = new URLSearchParams();
    for (const [k, v] of entries) sp.set(k, String(v));
    return `?${sp.toString()}`;
  }

  const enc = (s: string) => encodeURIComponent(s);

  return {
    // ── Arch Accounts ──
    getAccountSummary: (address) => getJson(`/accounts/${enc(address)}`),
    getAccountTokens: (address) => getJson(`/accounts/${enc(address)}/tokens`),
    getAccountTransactions: (address, limit = 50, page) =>
      getJson(`/accounts/${enc(address)}/transactions${qs({ limit, page })}`),
    getAccountTransactionsV2: (address, limit = 50, page = 1) =>
      getJson(`/accounts/${enc(address)}/transactions/v2${qs({ limit, page })}`),

    // ── Arch Transactions ──
    getTransactions: (params) =>
      getJson(`/transactions${qs({
        address: params.address,
        limit: params.limit,
        cursor: params.cursor,
        offset: params.offset,
        confirmed_after: params.confirmed_after,
        confirmed_before: params.confirmed_before,
        include_total: params.include_total
      })}`),
    getTransactionDetail: (txid) => getJson(`/transactions/${enc(txid)}`),
    getTransactionExecution: (txid) => getJson(`/transactions/${enc(txid)}/execution`),
    getTransactionInstructions: (txid) => getJson(`/transactions/${enc(txid)}/instructions`),
    getTransactionTree: (txid) => getJson(`/transactions/${enc(txid)}/tree`),

    // ── Tokens ──
    getTokens: (params) =>
      getJson(`/tokens${qs({ q: params?.q, sort: params?.sort, limit: params?.limit })}`),
    getTokenDetail: (mint) => getJson(`/tokens/${enc(mint)}`),
    getTokenLeaderboard: () => getJson("/tokens/leaderboard"),

    // ── Network ──
    getNetworkStats: () => getJson("/network/stats"),

    // ── Search ──
    search: (q) => getJson(`/search?q=${enc(q)}`),

    // ── Faucet ──
    requestFaucetAirdrop: (address) => postJson("/faucet/airdrop", { address }),

    // ── Bitcoin (via arch-indexer) ──
    getBtcAddressSummary: (address) => getJson(`/bitcoin/address/${enc(address)}`),
    getBtcAddressUtxos: (address) => getJson(`/bitcoin/address/${enc(address)}/utxo`),
    getBtcAddressTxs: (address, afterTxid) =>
      getJson(`/bitcoin/address/${enc(address)}/txs${afterTxid ? `?after_txid=${enc(afterTxid)}` : ""}`),
    getBtcAddressRunes: (address) =>
      getJson(`/bitcoin/address/${enc(address)}/runes`),
    getBtcAddressInscriptions: (address, cursor) =>
      getJson(`/bitcoin/address/${enc(address)}/inscriptions${cursor ? `?cursor=${enc(cursor)}` : ""}`),
    getBtcAddressRuneTransactions: (address, params) =>
      getJson(
        `/bitcoin/address/${enc(address)}/rune-transactions${qs({
          limit: params?.limit,
          cursor: params?.cursor,
          rune_id: params?.rune_id,
        })}`,
      ),
    getBtcInscription: (id) => getJson(`/bitcoin/inscriptions/${enc(id)}`),
    getBtcInscriptionContent: async (id) => {
      // Inscription content is binary (image/video/text/etc) so we
      // skip the JSON helpers and pull the raw upstream response.
      // Preserve content-type + cache-control so the Hub can replay
      // them to the wallet -- ord ships `immutable, max-age=1y`
      // which keeps thumbnails out of the indexer hot path after
      // the first fetch.
      const url = joinUrl(`/bitcoin/inscriptions/${enc(id)}/content`);
      let res: Response;
      try {
        res = await fetch(url, { headers: headers(), signal: abortSignal() });
      } catch (err: any) {
        const isAbort =
          err?.name === "AbortError" ||
          String(err?.message ?? "").toLowerCase().includes("abort");
        if (isAbort) throw new Error(`Indexer request timeout after ${timeoutMs}ms: ${url}`);
        throw err;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Indexer error ${res.status} ${res.statusText} (${url}): ${body}`);
      }
      const body = await res.arrayBuffer();
      const lengthHeader = res.headers.get("content-length");
      return {
        body,
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
        contentLength: lengthHeader ? Number(lengthHeader) : undefined,
        cacheControl: res.headers.get("cache-control") ?? undefined
      };
    },
    getBtcTransaction: (txid) => getJson(`/bitcoin/tx/${enc(txid)}`),
    getBtcTransactionStatus: (txid) => getJson(`/bitcoin/tx/${enc(txid)}/status`),
    broadcastBtcTransaction: (rawTxHex) => postText("/bitcoin/tx", rawTxHex),
    getBtcFeeEstimates: () => getJson("/bitcoin/fee-estimates"),
    getBtcChainTip: () => getJson("/bitcoin/tip"),
    getBtcBlock: (blockHash) => getJson(`/bitcoin/block/${enc(blockHash)}`),
    getBtcBlockHashAtHeight: (height) => getJson(`/bitcoin/block-height/${enc(String(height))}`),

    // ── Arch JSON-RPC compat ──
    // Wraps the upstream's `/rpc` envelope so callers can write
    // `await client.archRpc("read_account_info", [pubkey])` and get
    // back just the result. On JSON-RPC error responses we throw,
    // matching the convention every other method uses.
    archRpc: async (method, params) => {
      const json: any = await postJson("/rpc", {
        jsonrpc: "2.0",
        id: 1,
        method,
        params
      });
      if (json?.error) {
        const msg = json.error.message ?? JSON.stringify(json.error);
        throw new Error(`Indexer RPC ${method} error: ${msg}`);
      }
      return json?.result;
    }
  };
}
