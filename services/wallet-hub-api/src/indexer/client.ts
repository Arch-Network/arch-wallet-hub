import type { FastifyInstance } from "fastify";

export type IndexerClient = {
  getAddressSummary(address: string): Promise<unknown>;
  getUtxos(address: string): Promise<unknown>;
};

export function createIndexerClient(server: FastifyInstance): IndexerClient | null {
  const baseUrl = server.config.INDEXER_BASE_URL;
  if (!baseUrl) return null;

  async function getJson(path: string) {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { "content-type": "application/json" }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Indexer error ${res.status} ${res.statusText}: ${text}`);
    }
    return await res.json();
  }

  // NOTE: These paths are placeholders; we'll align to your existing indexer API routes once confirmed.
  return {
    getAddressSummary: async (address: string) =>
      await getJson(`/v1/bitcoin/address/${encodeURIComponent(address)}/summary`),
    getUtxos: async (address: string) =>
      await getJson(`/v1/bitcoin/address/${encodeURIComponent(address)}/utxos`)
  };
}

