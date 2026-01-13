import type { FastifyInstance } from "fastify";

export type BtcPlatformClient = {
  getAddressSummary(address: string): Promise<unknown>;
  getAddressUtxos(
    address: string,
    opts?: { confirmedOnly?: boolean }
  ): Promise<unknown>;
};

function joinUrl(base: string, path: string) {
  const left = base.endsWith("/") ? base.slice(0, -1) : base;
  const right = path.startsWith("/") ? path : `/${path}`;
  return `${left}${right}`;
}

/**
 * BTC Platform client (served by our API platform).
 *
 * Required endpoints:
 * - GET /api/v1/btc/addresses/:address
 * - GET /api/v1/btc/addresses/:address/utxos
 */
export function createBtcPlatformClient(server: FastifyInstance): BtcPlatformClient | null {
  const baseUrl = server.config.BTC_PLATFORM_BASE_URL;
  if (!baseUrl) return null;
  const baseUrlValue = baseUrl;
  const apiKey = server.config.BTC_PLATFORM_API_KEY;

  async function getJson(path: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) {
      headers["authorization"] = `Bearer ${apiKey}`;
      headers["x-api-key"] = apiKey;
    }

    const res = await fetch(joinUrl(baseUrlValue, path), { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err: any = new Error(
        `BTC platform error ${res.status} ${res.statusText}: ${text}`
      );
      err.statusCode = res.status;
      throw err;
    }
    return await res.json();
  }

  return {
    getAddressSummary: async (address: string) =>
      await getJson(`/api/v1/btc/addresses/${encodeURIComponent(address)}`),
    getAddressUtxos: async (address: string, opts?: { confirmedOnly?: boolean }) => {
      const qs =
        opts?.confirmedOnly === undefined
          ? ""
          : `?confirmed_only=${opts.confirmedOnly ? "true" : "false"}`;
      return await getJson(
        `/api/v1/btc/addresses/${encodeURIComponent(address)}/utxos${qs}`
      );
    }
  };
}
