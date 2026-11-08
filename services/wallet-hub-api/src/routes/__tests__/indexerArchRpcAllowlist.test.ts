import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { registerIndexerRoutes } from "../indexer.js";
import {
  setIndexerClient,
  setNetworkIndexerClient,
} from "../../indexer/store.js";
import type { IndexerClient } from "../../indexer/client.js";
import { InscriptionContentTooLargeError } from "../../indexer/inscriptionContentCap.js";

/**
 * Route-level guards for issue #45 without Postgres / appAuth:
 * mount only the indexer plugin + sensible, seed a stub IndexerClient.
 */
function stubIndexer(overrides: Partial<IndexerClient> = {}): IndexerClient {
  return {
    getAccountSummary: async () => ({}),
    getAccountTokens: async () => ({}),
    getAccountTransactions: async () => ({}),
    getAccountTransactionsV2: async () => ({}),
    getTransactions: async () => ({}),
    getTransactionDetail: async () => ({}),
    getTransactionExecution: async () => ({}),
    getTransactionInstructions: async () => ({}),
    getTransactionTree: async () => ({}),
    getTokens: async () => ({}),
    getTokenDetail: async () => ({}),
    getTokenLeaderboard: async () => ({}),
    getNetworkStats: async () => ({}),
    search: async () => ({}),
    requestFaucetAirdrop: async () => ({}),
    getBtcAddressSummary: async () => ({}),
    getBtcAddressUtxos: async () => ([]),
    getBtcAddressTxs: async () => ([]),
    getBtcAddressRunes: async () => ({}),
    getBtcAddressInscriptions: async () => ({}),
    getBtcAddressRuneTransactions: async () => ({}),
    getBtcInscription: async () => ({}),
    getBtcInscriptionContent: async () => ({
      body: new Uint8Array([1]).buffer,
      contentType: "application/octet-stream",
    }),
    getBtcTransaction: async () => ({}),
    getBtcTransactionStatus: async () => ({}),
    broadcastBtcTransaction: async () => "txid",
    getBtcFeeEstimates: async () => ({}),
    getBtcChainTip: async () => ({}),
    getBtcBlock: async () => ({}),
    getBtcBlockHashAtHeight: async () => "00",
    archRpc: async () => ({ ok: true }),
    ...overrides,
  };
}

async function buildApp(indexer: IndexerClient) {
  setIndexerClient(indexer);
  setNetworkIndexerClient("testnet", indexer);
  setNetworkIndexerClient("mainnet", indexer);

  const app = Fastify();
  await app.register(sensible);
  await app.register(registerIndexerRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

const VALID_INSCRIPTION_ID =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaai0";

describe("POST /v1/indexer/arch/rpc allowlist (issue #45)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let archRpcCalls: Array<{ method: string; params: unknown }>;

  beforeEach(async () => {
    archRpcCalls = [];
    app = await buildApp(
      stubIndexer({
        archRpc: async (method, params) => {
          archRpcCalls.push({ method, params });
          return { method, echoed: true };
        },
      }),
    );
  });

  afterEach(async () => {
    await app.close();
    setIndexerClient(null);
  });

  it("forwards an allowlisted read method", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/indexer/arch/rpc",
      payload: { method: "read_account_info", params: ["pubkey"] },
    });
    expect(res.statusCode).toBe(200);
    expect(archRpcCalls).toEqual([
      { method: "read_account_info", params: ["pubkey"] },
    ]);
    expect(res.json()).toEqual({ method: "read_account_info", echoed: true });
  });

  it("403s a mutating method before calling upstream", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/indexer/arch/rpc",
      payload: { method: "send_transaction", params: ["deadbeef"] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/not allowed/i);
    expect(archRpcCalls).toEqual([]);
  });

  it("403s an unknown method", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/indexer/arch/rpc",
      payload: { method: "request_airdrop", params: [] },
    });
    expect(res.statusCode).toBe(403);
    expect(archRpcCalls).toEqual([]);
  });
});

describe("GET /v1/indexer/btc/inscriptions/:id/content size cap (issue #45)", () => {
  afterEach(() => {
    setIndexerClient(null);
  });

  it("413s when the indexer client reports content too large", async () => {
    const app = await buildApp(
      stubIndexer({
        getBtcInscriptionContent: async () => {
          throw new InscriptionContentTooLargeError(3_000_000);
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/v1/indexer/btc/inscriptions/${VALID_INSCRIPTION_ID}/content`,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("PayloadTooLarge");
    await app.close();
  });

  it("200s a small content body", async () => {
    const payload = new Uint8Array([10, 20, 30]);
    const app = await buildApp(
      stubIndexer({
        getBtcInscriptionContent: async () => ({
          body: payload.buffer.slice(
            payload.byteOffset,
            payload.byteOffset + payload.byteLength,
          ),
          contentType: "image/png",
          contentLength: 3,
        }),
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/v1/indexer/btc/inscriptions/${VALID_INSCRIPTION_ID}/content`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(Buffer.from(res.rawPayload)).toEqual(Buffer.from(payload));
    await app.close();
  });
});
