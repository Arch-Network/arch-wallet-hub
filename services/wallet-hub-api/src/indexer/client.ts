import type { FastifyInstance } from "fastify";

export type IndexerClient = {
  getAccountSummary(address: string): Promise<unknown>;
  getAccountTokens(address: string): Promise<unknown>;
  getAccountTransactions(address: string, limit?: number, page?: number): Promise<unknown>;
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

  getTokens(params?: { q?: string; sort?: string; limit?: number }): Promise<unknown>;
  getTokenDetail(mint: string): Promise<unknown>;
  getTokenLeaderboard(): Promise<unknown>;

  getNetworkStats(): Promise<unknown>;

  search(q: string): Promise<unknown>;

  requestFaucetAirdrop(address: string): Promise<unknown>;

  getBtcAddressSummary(address: string): Promise<unknown>;
  getBtcAddressUtxos(address: string): Promise<unknown>;
  getBtcAddressTxs(address: string, afterTxid?: string): Promise<unknown>;
  getBtcTransaction(txid: string): Promise<unknown>;
  getBtcTransactionStatus(txid: string): Promise<unknown>;
  broadcastBtcTransaction(rawTxHex: string): Promise<unknown>;
  getBtcFeeEstimates(): Promise<unknown>;
  getBtcChainTip(): Promise<unknown>;
};

export function createIndexerClient(server: FastifyInstance): IndexerClient | null {
  const baseUrl = server.config.INDEXER_BASE_URL;
  if (!baseUrl) return null;
  const baseUrlValue = baseUrl;
  const apiKey = server.config.INDEXER_API_KEY;
  const timeoutMs = (server.config as any).INDEXER_TIMEOUT_MS ?? 10_000;

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

    // ── Bitcoin ──
    getBtcAddressSummary: (address) => getJson(`/bitcoin/address/${enc(address)}`),
    getBtcAddressUtxos: (address) => getJson(`/bitcoin/address/${enc(address)}/utxo`),
    getBtcAddressTxs: (address, afterTxid) =>
      getJson(`/bitcoin/address/${enc(address)}/txs${afterTxid ? `?after_txid=${enc(afterTxid)}` : ""}`),
    getBtcTransaction: (txid) => getJson(`/bitcoin/tx/${enc(txid)}`),
    getBtcTransactionStatus: (txid) => getJson(`/bitcoin/tx/${enc(txid)}/status`),
    broadcastBtcTransaction: (rawTxHex) => postText("/bitcoin/tx", rawTxHex),
    getBtcFeeEstimates: () => getJson("/bitcoin/fee-estimates"),
    getBtcChainTip: () => getJson("/bitcoin/tip")
  };
}
