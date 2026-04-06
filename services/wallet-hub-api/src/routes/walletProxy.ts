import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import { getIndexerClient, getNetworkIndexerClient } from "../indexer/store.js";
import { resolveArchAccountAddress, reEncodeTaprootForNetwork } from "../arch/address.js";

const AddressParams = Type.Object({ address: Type.String({ minLength: 1 }) });
const TxidParams = Type.Object({ txid: Type.String({ minLength: 1 }) });
const MintParams = Type.Object({ mint: Type.String({ minLength: 1 }) });

function requestNetwork(request: FastifyRequest): "mainnet" | "testnet" {
  const h = (request.headers["x-network"] as string)?.toLowerCase();
  return h === "mainnet" ? "mainnet" : "testnet";
}

function indexerForRequest(request: FastifyRequest, reply: any) {
  const network = requestNetwork(request);
  const client = getNetworkIndexerClient(network);
  if (client) return client;
  const indexer = getIndexerClient();
  if (!indexer) {
    reply.notImplemented("Indexer not configured (INDEXER_BASE_URL missing)");
    return null;
  }
  return indexer;
}

/**
 * Re-encode a BTC taproot address so it matches the network the caller selected.
 * e.g. tb1p... → bc1p... when X-Network: mainnet.
 */
function btcAddressForRequest(address: string, request: FastifyRequest): string {
  return reEncodeTaprootForNetwork(address, requestNetwork(request));
}

const OVERVIEW_TTL_MS = 30_000;
const OVERVIEW_PARTIAL_TTL_MS = 10_000;
const OVERVIEW_FAST_TIMEOUT_MS = 5_000;
const TX_HISTORY_TIMEOUT_MS = 15_000;

const EMPTY_TX_RESPONSE = { total_count: 0, next_cursor: null, page: null, limit: null, transactions: [] };
const overviewCache = new Map<string, { ts: number; ttl: number; data: unknown }>();

function raceWithTimeout<T>(promise: Promise<T>, ms: number, _label?: string): Promise<{ value: T; timedOut: false } | { value: null; timedOut: true }> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ value: null; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ value: null, timedOut: true }), ms);
  });
  return Promise.race([
    promise.then((value) => ({ value, timedOut: false as const })),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

export const registerWalletProxyRoutes: FastifyPluginAsync = async (server) => {
  // ── Wallet Overview (aggregated dashboard data) ──

  server.get(
    "/wallet/:address/overview",
    {
      schema: {
        summary: "Aggregated wallet overview: BTC + ARCH balances, recent txs",
        tags: ["wallet"],
        params: AddressParams
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const { address } = request.params as any;

      const networkHeader = (request.headers["x-network"] as string)?.toLowerCase() || "testnet";
      const cacheKey = `${networkHeader}:${address}`;

      const noCache =
        (request.query as any)?.nocache !== undefined ||
        request.headers["cache-control"]?.includes("no-cache");

      const cached = overviewCache.get(cacheKey);
      if (!noCache && cached && Date.now() - cached.ts < cached.ttl) {
        return cached.data;
      }

      const resolved = resolveArchAccountAddress(address);
      const rawBtcAddr = resolved.kind === "taproot" ? resolved.taprootAddress : address;
      const btcAddress = btcAddressForRequest(rawBtcAddr, request);
      const archAddressOverride = (request.query as any)?.archAddress;
      const queryAddr = archAddressOverride || resolved.archAccountAddress;

      const [archAccount, btcSummary] = await Promise.all([
        raceWithTimeout(indexer.getAccountSummary(queryAddr), OVERVIEW_FAST_TIMEOUT_MS, "getAccountSummary"),
        raceWithTimeout(indexer.getBtcAddressSummary(btcAddress), OVERVIEW_FAST_TIMEOUT_MS, "getBtcAddressSummary"),
      ]);

      const archAccountData = archAccount.timedOut ? null : archAccount.value as any;

      const hasTxs = archAccountData?.transaction_count > 0;
      const archTxs = hasTxs
        ? await raceWithTimeout(indexer.getAccountTransactions(queryAddr, 10), OVERVIEW_FAST_TIMEOUT_MS, "getAccountTransactions")
        : { value: EMPTY_TX_RESPONSE, timedOut: false as const };
      const displayAddress =
        archAccountData?.address ||
        archAccountData?.address_hex ||
        resolved.archAccountAddress;

      const data = {
        inputAddress: address,
        archAccountAddress: displayAddress,
        btcAddress,
        arch: {
          account: archAccountData,
          accountTimedOut: archAccount.timedOut,
          recentTransactions: archTxs.timedOut ? null : archTxs.value,
          recentTransactionsTimedOut: archTxs.timedOut,
        },
        btc: {
          summary: btcSummary.timedOut ? null : btcSummary.value,
          summaryTimedOut: btcSummary.timedOut,
        }
      };

      const anyTimedOut = archAccount.timedOut || archTxs.timedOut || btcSummary.timedOut;
      const ttl = anyTimedOut ? OVERVIEW_PARTIAL_TTL_MS : OVERVIEW_TTL_MS;
      overviewCache.set(cacheKey, { ts: Date.now(), ttl, data });
      if (overviewCache.size > 500) {
        const oldest = overviewCache.keys().next().value!;
        overviewCache.delete(oldest);
      }

      return data;
    }
  );

  // ── Arch Account ──

  server.get(
    "/wallet/:address/arch-account",
    {
      schema: {
        summary: "Arch account summary (balance, first/last seen)",
        tags: ["wallet"],
        params: AddressParams
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const { address } = request.params as any;
      const resolved = resolveArchAccountAddress(address);
      try {
        return await indexer.getAccountSummary(resolved.archAccountAddress);
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  // ── Account Token Holdings ──

  server.get(
    "/wallet/:address/tokens-held",
    {
      schema: {
        summary: "APL tokens held by an address (balances, metadata)",
        tags: ["wallet"],
        params: AddressParams,
        querystring: Type.Object({
          archAddress: Type.Optional(Type.String())
        })
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const { address } = request.params as any;
      const query = request.query as any;
      const resolved = resolveArchAccountAddress(address);
      const archAddr = query.archAddress || resolved.archAccountAddress;
      try {
        return await indexer.getAccountTokens(archAddr);
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  // ── Arch Transactions ──

  server.get(
    "/wallet/:address/transactions",
    {
      schema: {
        summary: "Arch transaction history for an account",
        tags: ["wallet"],
        params: AddressParams,
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
          page: Type.Optional(Type.Integer({ minimum: 1 })),
          archAddress: Type.Optional(Type.String())
        })
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const { address } = request.params as any;
      const query = request.query as any;
      const resolved = resolveArchAccountAddress(address);
      const archAddr = query.archAddress || resolved.archAccountAddress;
      try {
        const summary = await raceWithTimeout(
          indexer.getAccountSummary(archAddr),
          OVERVIEW_FAST_TIMEOUT_MS,
          "getAccountSummary-txPage",
        );
        if (!summary.timedOut && (summary.value as any)?.transaction_count === 0) {
          return EMPTY_TX_RESPONSE;
        }

        const result = await raceWithTimeout(
          indexer.getAccountTransactions(archAddr, query.limit, query.page),
          TX_HISTORY_TIMEOUT_MS,
        );
        if (result.timedOut) {
          return reply.code(504).send({
            error: "UpstreamTimeout",
            message: "Transaction history is temporarily unavailable — the upstream explorer is not responding. Balances and other data are unaffected.",
          });
        }
        return result.value;
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  server.get(
    "/wallet/transactions/:txid",
    {
      schema: {
        summary: "Get Arch transaction details by txid",
        tags: ["wallet"],
        params: TxidParams
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const { txid } = request.params as any;
      try {
        return await indexer.getTransactionDetail(txid);
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  // ── Tokens ──

  server.get(
    "/wallet/tokens",
    {
      schema: {
        summary: "List tokens on Arch network",
        tags: ["wallet"],
        querystring: Type.Object({
          q: Type.Optional(Type.String()),
          sort: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 }))
        })
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const query = request.query as any;
      try {
        return await indexer.getTokens({ q: query.q, sort: query.sort, limit: query.limit });
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  server.get(
    "/wallet/tokens/:mint",
    {
      schema: {
        summary: "Get token detail by mint address",
        tags: ["wallet"],
        params: MintParams
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const { mint } = request.params as any;
      try {
        return await indexer.getTokenDetail(mint);
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  // ── Network Stats ──

  server.get(
    "/wallet/network/stats",
    {
      schema: { summary: "Arch network statistics", tags: ["wallet"] }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      try {
        return await indexer.getNetworkStats();
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  // ── Faucet Airdrop ──

  server.post(
    "/wallet/faucet/airdrop",
    {
      schema: {
        summary: "Request testnet airdrop via Arch Indexer faucet",
        tags: ["wallet"],
        body: Type.Object({ address: Type.String({ minLength: 1 }) })
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const { address } = request.body as any;
      try {
        return await indexer.requestFaucetAirdrop(address);
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  // ── Bitcoin Proxy ──

  server.get(
    "/wallet/btc/address/:address",
    {
      schema: {
        summary: "Bitcoin address summary (balance, funded/spent)",
        tags: ["wallet", "bitcoin"],
        params: AddressParams
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const addr = btcAddressForRequest((request.params as any).address, request);
      try {
        return await indexer.getBtcAddressSummary(addr);
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  server.get(
    "/wallet/btc/address/:address/utxos",
    {
      schema: {
        summary: "Bitcoin address UTXOs",
        tags: ["wallet", "bitcoin"],
        params: AddressParams
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const addr = btcAddressForRequest((request.params as any).address, request);
      try {
        return await indexer.getBtcAddressUtxos(addr);
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  server.get(
    "/wallet/btc/address/:address/txs",
    {
      schema: {
        summary: "Bitcoin address transactions",
        tags: ["wallet", "bitcoin"],
        params: AddressParams,
        querystring: Type.Object({
          after_txid: Type.Optional(Type.String())
        })
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const addr = btcAddressForRequest((request.params as any).address, request);
      const { after_txid } = request.query as any;
      try {
        return await indexer.getBtcAddressTxs(addr, after_txid);
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  server.get(
    "/wallet/btc/tx/:txid",
    {
      schema: {
        summary: "Bitcoin transaction details",
        tags: ["wallet", "bitcoin"],
        params: TxidParams
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const { txid } = request.params as any;
      try {
        return await indexer.getBtcTransaction(txid);
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  server.get(
    "/wallet/btc/fee-estimates",
    {
      schema: { summary: "Bitcoin fee rate estimates (sat/vB)", tags: ["wallet", "bitcoin"] }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      try {
        return await indexer.getBtcFeeEstimates();
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  server.get(
    "/wallet/btc/tip",
    {
      schema: { summary: "Bitcoin chain tip (height + hash)", tags: ["wallet", "bitcoin"] }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      try {
        return await indexer.getBtcChainTip();
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  server.post(
    "/wallet/btc/broadcast",
    {
      schema: {
        summary: "Broadcast a raw Bitcoin transaction",
        tags: ["wallet", "bitcoin"],
        body: Type.Object({ rawTxHex: Type.String({ minLength: 1 }) })
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const { rawTxHex } = request.body as any;
      try {
        const txid = await indexer.broadcastBtcTransaction(rawTxHex);
        return { txid };
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );

  // ── Search ──

  server.get(
    "/wallet/search",
    {
      schema: {
        summary: "Universal search (blocks, txs, accounts, tokens)",
        tags: ["wallet"],
        querystring: Type.Object({ q: Type.String({ minLength: 1 }) })
      }
    },
    async (request, reply) => {
      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;
      const { q } = request.query as any;
      try {
        return await indexer.search(q);
      } catch (err: any) {
        return reply.code(502).send({ error: "IndexerError", message: err.message });
      }
    }
  );
};
