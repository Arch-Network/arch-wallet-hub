import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { getIndexerClient } from "../indexer/store.js";
import { resolveArchAccountAddress } from "../arch/address.js";

const AddressParams = Type.Object({ address: Type.String({ minLength: 1 }) });
const TxidParams = Type.Object({ txid: Type.String({ minLength: 1 }) });
const MintParams = Type.Object({ mint: Type.String({ minLength: 1 }) });

function indexerOrFail(reply: any) {
  const indexer = getIndexerClient();
  if (!indexer) {
    reply.notImplemented("Indexer not configured (INDEXER_BASE_URL missing)");
    return null;
  }
  return indexer;
}

const OVERVIEW_TTL_MS = 30_000;
const overviewCache = new Map<string, { ts: number; data: unknown }>();

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
      const indexer = indexerOrFail(reply);
      if (!indexer) return;
      const { address } = request.params as any;

      const noCache =
        (request.query as any)?.nocache !== undefined ||
        request.headers["cache-control"]?.includes("no-cache");

      const cached = overviewCache.get(address);
      if (!noCache && cached && Date.now() - cached.ts < OVERVIEW_TTL_MS) {
        return cached.data;
      }

      const resolved = resolveArchAccountAddress(address);
      const btcAddress = resolved.kind === "taproot" ? resolved.taprootAddress : address;
      const archAddressOverride = (request.query as any)?.archAddress;
      const queryAddr = archAddressOverride || resolved.archAccountAddress;

      const [archAccount, archTxs, btcSummary] = await Promise.allSettled([
        indexer.getAccountSummary(queryAddr),
        indexer.getAccountTransactions(queryAddr, 10),
        indexer.getBtcAddressSummary(btcAddress)
      ]);

      const archAccountData = archAccount.status === "fulfilled" ? archAccount.value as any : null;
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
          recentTransactions: archTxs.status === "fulfilled" ? archTxs.value : null
        },
        btc: {
          summary: btcSummary.status === "fulfilled" ? btcSummary.value : null
        }
      };

      overviewCache.set(address, { ts: Date.now(), data });
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
      const indexer = indexerOrFail(reply);
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
        params: AddressParams
      }
    },
    async (request, reply) => {
      const indexer = indexerOrFail(reply);
      if (!indexer) return;
      const { address } = request.params as any;
      const resolved = resolveArchAccountAddress(address);
      try {
        return await indexer.getAccountTokens(resolved.archAccountAddress);
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
          page: Type.Optional(Type.Integer({ minimum: 1 }))
        })
      }
    },
    async (request, reply) => {
      const indexer = indexerOrFail(reply);
      if (!indexer) return;
      const { address } = request.params as any;
      const query = request.query as any;
      const resolved = resolveArchAccountAddress(address);
      try {
        return await indexer.getAccountTransactions(
          resolved.archAccountAddress,
          query.limit,
          query.page
        );
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
      const indexer = indexerOrFail(reply);
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
      const indexer = indexerOrFail(reply);
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
      const indexer = indexerOrFail(reply);
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
    async (_request, reply) => {
      const indexer = indexerOrFail(reply);
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
      const indexer = indexerOrFail(reply);
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
      const indexer = indexerOrFail(reply);
      if (!indexer) return;
      const { address } = request.params as any;
      try {
        return await indexer.getBtcAddressSummary(address);
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
      const indexer = indexerOrFail(reply);
      if (!indexer) return;
      const { address } = request.params as any;
      try {
        return await indexer.getBtcAddressUtxos(address);
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
      const indexer = indexerOrFail(reply);
      if (!indexer) return;
      const { address } = request.params as any;
      const { after_txid } = request.query as any;
      try {
        return await indexer.getBtcAddressTxs(address, after_txid);
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
      const indexer = indexerOrFail(reply);
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
    async (_request, reply) => {
      const indexer = indexerOrFail(reply);
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
    async (_request, reply) => {
      const indexer = indexerOrFail(reply);
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
      const indexer = indexerOrFail(reply);
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
      const indexer = indexerOrFail(reply);
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
