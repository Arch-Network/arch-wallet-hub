import type { FastifyInstance } from "fastify";

export type IndexerClient = {
  getAccountSummary(address: string): Promise<unknown>;
  getAccountTransactions(address: string, limit?: number): Promise<unknown>;
  getTransactions(params: { address?: string; limit?: number; cursor?: string; offset?: number }): Promise<unknown>;
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

  async function getJson(path: string) {
    const url = joinUrl(path);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) {
      // Matches your OpenAPI security scheme.
      headers["authorization"] = `Bearer ${apiKey}`;
      headers["x-api-key"] = apiKey;
    }

    // Prevent requests from hanging for a full reverse-proxy timeout.
    const signal =
      typeof (AbortSignal as any)?.timeout === "function"
        ? (AbortSignal as any).timeout(timeoutMs)
        : undefined;

    let res: Response;
    try {
      res = await fetch(url, { headers, signal });
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

  return {
    getAccountSummary: async (address: string) =>
      await getJson(`/api/v1/accounts/${encodeURIComponent(address)}`),
    getAccountTransactions: async (address: string, limit = 50) =>
      await getJson(`/api/v1/accounts/${encodeURIComponent(address)}/transactions?limit=${limit}`),
    getTransactions: async (params) => {
      const qs = new URLSearchParams();
      if (params.address) qs.set("address", params.address);
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      if (params.cursor) qs.set("cursor", params.cursor);
      if (params.offset !== undefined) qs.set("offset", String(params.offset));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return await getJson(`/api/v1/transactions${suffix}`);
    }
  };
}
