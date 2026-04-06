import type { FastifyInstance } from "fastify";
import { bech32m, bech32 } from "bech32";

/**
 * Decode a hex script_pubkey into a Bitcoin address.
 * Supports P2TR (Taproot), P2WPKH, and P2WSH segwit scripts.
 * Returns undefined for unsupported script types.
 */
function scriptPubkeyToAddress(
  hex: string,
  network: "mainnet" | "testnet" = "testnet",
): string | undefined {
  if (!hex || hex.length < 4) return undefined;
  const prefix = network === "mainnet" ? "bc" : "tb";

  try {
    const opcode = parseInt(hex.slice(0, 2), 16);
    const pushLen = parseInt(hex.slice(2, 4), 16);
    const program = hex.slice(4);

    if (program.length !== pushLen * 2) return undefined;

    const words5 = bech32m.toWords(Buffer.from(program, "hex"));

    if (opcode === 0x51 && pushLen === 32) {
      return bech32m.encode(prefix, [1, ...words5]);
    }
    if (opcode === 0x00 && (pushLen === 20 || pushLen === 32)) {
      const w = bech32.toWords(Buffer.from(program, "hex"));
      return bech32.encode(prefix, [0, ...w]);
    }
  } catch {
    // not decodable
  }
  return undefined;
}

/**
 * Enrich a Titan transaction object by adding decoded `script_pubkey_address`
 * fields to outputs and input previous_output_data.
 */
function enrichTitanTx(tx: any, network: "mainnet" | "testnet" = "testnet"): any {
  if (!tx || typeof tx !== "object") return tx;

  if (Array.isArray(tx.output)) {
    tx.output = tx.output.map((o: any) => {
      if (o?.script_pubkey && !o.script_pubkey_address) {
        const addr = scriptPubkeyToAddress(o.script_pubkey, network);
        if (addr) o.script_pubkey_address = addr;
      }
      return o;
    });
  }

  if (Array.isArray(tx.input)) {
    tx.input = tx.input.map((i: any) => {
      const pod = i?.previous_output_data;
      if (pod?.script_pubkey && !pod.script_pubkey_address) {
        const addr = scriptPubkeyToAddress(pod.script_pubkey, network);
        if (addr) pod.script_pubkey_address = addr;
      }
      return i;
    });
  }

  return tx;
}

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

    // ── Bitcoin (via arch-indexer proxy — fallback when Titan is not configured) ──
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

/**
 * Create a Titan-direct client that overrides the Bitcoin methods on an
 * existing IndexerClient. Titan returns richer data (full tx objects with
 * `status.confirmed`) and avoids the arch-indexer proxy bottleneck.
 */
export function withTitanBtc(base: IndexerClient, titanBaseUrl: string, timeoutMs = 30_000): IndexerClient {
  const titanUrl = titanBaseUrl.endsWith("/") ? titanBaseUrl.slice(0, -1) : titanBaseUrl;

  function titanAbortSignal() {
    return typeof (AbortSignal as any)?.timeout === "function"
      ? (AbortSignal as any).timeout(timeoutMs)
      : undefined;
  }

  async function titanGet(path: string) {
    const url = `${titanUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: titanAbortSignal() });
    } catch (err: any) {
      const isAbort = err?.name === "AbortError" || String(err?.message ?? "").toLowerCase().includes("abort");
      if (isAbort) throw new Error(`Titan request timeout after ${timeoutMs}ms: ${url}`);
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Titan error ${res.status} ${res.statusText} (${url}): ${text}`);
    }
    return await res.json();
  }

  async function titanPostText(path: string, body: string): Promise<string> {
    const url = `${titanUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body,
        signal: titanAbortSignal()
      });
    } catch (err: any) {
      const isAbort = err?.name === "AbortError" || String(err?.message ?? "").toLowerCase().includes("abort");
      if (isAbort) throw new Error(`Titan request timeout after ${timeoutMs}ms: ${url}`);
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Titan error ${res.status} ${res.statusText} (${url}): ${text}`);
    }
    return await res.text();
  }

  const enc = (s: string) => encodeURIComponent(s);

  return {
    ...base,

    getBtcAddressSummary: (address) => titanGet(`/address/${enc(address)}`),

    getBtcAddressUtxos: async (address) => {
      const data: any = await titanGet(`/address/${enc(address)}`);
      const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
      return outputs
        .filter((o: any) => {
          const spent = o?.spent;
          if (typeof spent === "object" && spent !== null) return spent.spent === false;
          if (spent === false || spent === undefined) return true;
          return false;
        })
        .map((o: any) => ({
          txid: o.txid,
          vout: o.vout,
          value: o.value,
          status: o.status,
        }));
    },

    getBtcAddressTxs: async (address) => {
      const data: any = await titanGet(`/address/${enc(address)}`);
      const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
      const seen = new Set<string>();
      return outputs
        .map((o: any) => o?.txid)
        .filter((txid: any): txid is string => typeof txid === "string" && !seen.has(txid) && (seen.add(txid), true));
    },

    getBtcTransaction: async (txid) => enrichTitanTx(await titanGet(`/tx/${enc(txid)}`)),

    getBtcTransactionStatus: (txid) => titanGet(`/tx/${enc(txid)}/status`),

    broadcastBtcTransaction: (rawTxHex) => titanPostText("/tx/broadcast", rawTxHex),

    getBtcFeeEstimates: async () => {
      // Titan doesn't have fee estimates; use mempool.space
      try {
        const res = await fetch("https://mempool.space/testnet4/api/v1/fees/recommended", {
          signal: titanAbortSignal()
        });
        if (!res.ok) return {};
        return await res.json();
      } catch {
        return {};
      }
    },

    getBtcChainTip: () => titanGet("/tip"),
  };
}
