/**
 * Indexer proxy routes.
 *
 * Why this exists:
 *   The chrome extension used to ship the privileged Indexer API key
 *   in its bundle. Every leaked-bundle copy shared the same quota and
 *   the wallet got rate-limited in the wild. Removing the hardcoded
 *   key + shipping no-key bundles made first-touch reads break.
 *
 *   We solve both by mounting the existing server-side `IndexerClient`
 *   as HTTP routes under `/v1/indexer/*`. The privileged Indexer key
 *   stays inside the Hub process. The extension authenticates as an
 *   *app* (the existing per-app `x-api-key`) and the Hub forwards to
 *   the upstream Indexer with the privileged key.
 *
 * Auth model (MetaMask/Infura precedent):
 *   - `requireAppAuth` global hook gates every route here (any
 *     non-public `/v1/...` route requires a valid app key).
 *   - Public-data reads only -- no per-user session needed. This is
 *     critical: the Dashboard loads before any onboarding, so the
 *     read path must work for users who haven't yet linked a Turnkey
 *     resource.
 *   - For attribution + per-install rate-limiting, the wallet sends
 *     `x-arch-install-id` (already stored in `chrome.storage.local`).
 *     Route-level rate limits and per-installation throttling are
 *     wired in subsequent commits.
 *
 * Network selection:
 *   `x-network` header (`testnet` | `mainnet`) -- same convention as
 *   the existing `indexerForRequest` helper used by other routes.
 *
 * Shape:
 *   Routes are *typed*, not a generic pass-through. We mirror every
 *   method on `IndexerClient` 1:1 so we can:
 *     - Validate path / query / body via TypeBox up-front (block
 *       SSRF-via-malformed-path attempts before they reach the
 *       upstream Indexer).
 *     - Add per-method audit logging and rate-limit overrides
 *       without conditional dispatch.
 *     - Evolve our wire contract independently of the upstream
 *       Indexer's wire shape (we can renumber, rename, version).
 *
 * Mutating endpoints (faucet + broadcast) are wired in a follow-on
 * commit so they pick up the HMAC audit chain from PR #15.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import { indexerForRequest } from "../indexer/forRequest.js";
import type { IndexerClient } from "../indexer/client.js";

/** Pull the per-request indexer client or short-circuit with a 501. */
function indexerOr501(
  request: FastifyRequest,
  reply: FastifyReply,
): IndexerClient | null {
  return indexerForRequest(request, reply);
}

/**
 * Wrap an `IndexerClient` call: forwards the result as-is when it
 * resolves, maps upstream errors to a stable 502 envelope so the
 * wallet's client adapter has one error shape to reason about.
 *
 * We intentionally do NOT echo the upstream's verbatim status code.
 * A 429 from the upstream indexer is OUR problem (we hold the
 * privileged key); surfacing it as 429 to the wallet would falsely
 * suggest the wallet itself is being throttled and trigger its own
 * backoff. Surfacing as 502 says "upstream had a problem, not you,
 * keep going at your normal pace" -- the wallet-side client treats
 * 502 as transient.
 */
async function forward<T>(
  reply: FastifyReply,
  op: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await op();
  } catch (err: any) {
    const message = err?.message ? String(err.message) : "Indexer proxy failed";
    reply
      .code(502)
      .send({ statusCode: 502, error: "BadGateway", message });
    return undefined;
  }
}

const AddressParam = Type.Object({ address: Type.String({ minLength: 1 }) });
const TxidParam = Type.Object({ txid: Type.String({ minLength: 1 }) });
const MintParam = Type.Object({ mint: Type.String({ minLength: 1 }) });

const TransactionsQuery = Type.Object({
  address: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  cursor: Type.Optional(Type.String()),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  confirmed_after: Type.Optional(Type.String()),
  confirmed_before: Type.Optional(Type.String()),
  include_total: Type.Optional(Type.Boolean()),
});

const AccountTransactionsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
});

const TokensQuery = Type.Object({
  q: Type.Optional(Type.String()),
  sort: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

const SearchQuery = Type.Object({ q: Type.String({ minLength: 1 }) });

const BtcTxsQuery = Type.Object({
  after_txid: Type.Optional(Type.String()),
});

const FaucetBody = Type.Object({
  address: Type.String({ minLength: 1 }),
});

const BroadcastBody = Type.Object({
  rawTxHex: Type.String({
    minLength: 2,
    maxLength: 256 * 1024,
    pattern: "^[0-9a-fA-F]+$",
  }),
});

const BroadcastResponse = Type.Object({ txid: Type.String() });

export const registerIndexerRoutes: FastifyPluginAsync = async (server) => {
  // ── Arch Accounts ──────────────────────────────────────────────
  server.get(
    "/indexer/arch/accounts/:address",
    {
      schema: {
        summary: "Get Arch account summary (proxied)",
        tags: ["indexer"],
        params: AddressParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { address } = request.params as { address: string };
      const result = await forward(reply, () =>
        indexer.getAccountSummary(address),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  server.get(
    "/indexer/arch/accounts/:address/tokens",
    {
      schema: {
        summary: "Get Arch account tokens (proxied)",
        tags: ["indexer"],
        params: AddressParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { address } = request.params as { address: string };
      const result = await forward(reply, () =>
        indexer.getAccountTokens(address),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  server.get(
    "/indexer/arch/accounts/:address/transactions",
    {
      schema: {
        summary: "Get Arch account transactions (proxied)",
        tags: ["indexer"],
        params: AddressParam,
        querystring: AccountTransactionsQuery,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { address } = request.params as { address: string };
      const { limit, page } = request.query as {
        limit?: number;
        page?: number;
      };
      const result = await forward(reply, () =>
        indexer.getAccountTransactions(address, limit, page),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  // ── Arch Transactions ──────────────────────────────────────────
  server.get(
    "/indexer/arch/transactions",
    {
      schema: {
        summary: "List Arch transactions (proxied)",
        tags: ["indexer"],
        querystring: TransactionsQuery,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const q = request.query as Record<string, unknown>;
      const result = await forward(reply, () =>
        indexer.getTransactions({
          address: q.address as string | undefined,
          limit: q.limit as number | undefined,
          cursor: q.cursor as string | undefined,
          offset: q.offset as number | undefined,
          confirmed_after: q.confirmed_after as string | undefined,
          confirmed_before: q.confirmed_before as string | undefined,
          include_total: q.include_total as boolean | undefined,
        }),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  server.get(
    "/indexer/arch/transactions/:txid",
    {
      schema: {
        summary: "Get Arch transaction detail (proxied)",
        tags: ["indexer"],
        params: TxidParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { txid } = request.params as { txid: string };
      const result = await forward(reply, () =>
        indexer.getTransactionDetail(txid),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  server.get(
    "/indexer/arch/transactions/:txid/execution",
    {
      schema: {
        summary: "Get Arch transaction execution (proxied)",
        tags: ["indexer"],
        params: TxidParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { txid } = request.params as { txid: string };
      const result = await forward(reply, () =>
        indexer.getTransactionExecution(txid),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  // ── Tokens ─────────────────────────────────────────────────────
  // /leaderboard is registered BEFORE /:mint so Fastify's routing
  // trie matches the static segment first.
  server.get(
    "/indexer/arch/tokens/leaderboard",
    {
      schema: {
        summary: "Token leaderboard (proxied)",
        tags: ["indexer"],
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const result = await forward(reply, () => indexer.getTokenLeaderboard());
      if (result !== undefined) reply.send(result);
    },
  );

  server.get(
    "/indexer/arch/tokens",
    {
      schema: {
        summary: "List tokens (proxied)",
        tags: ["indexer"],
        querystring: TokensQuery,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { q, sort, limit } = request.query as {
        q?: string;
        sort?: string;
        limit?: number;
      };
      const result = await forward(reply, () =>
        indexer.getTokens({ q, sort, limit }),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  server.get(
    "/indexer/arch/tokens/:mint",
    {
      schema: {
        summary: "Get token detail (proxied)",
        tags: ["indexer"],
        params: MintParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { mint } = request.params as { mint: string };
      const result = await forward(reply, () => indexer.getTokenDetail(mint));
      if (result !== undefined) reply.send(result);
    },
  );

  // ── Network ────────────────────────────────────────────────────
  server.get(
    "/indexer/arch/network/stats",
    {
      schema: {
        summary: "Arch network stats (proxied)",
        tags: ["indexer"],
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const result = await forward(reply, () => indexer.getNetworkStats());
      if (result !== undefined) reply.send(result);
    },
  );

  // ── Search ─────────────────────────────────────────────────────
  server.get(
    "/indexer/arch/search",
    {
      schema: {
        summary: "Indexer search (proxied)",
        tags: ["indexer"],
        querystring: SearchQuery,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { q } = request.query as { q: string };
      const result = await forward(reply, () => indexer.search(q));
      if (result !== undefined) reply.send(result);
    },
  );

  // ── Faucet (mutating; audit hookup follows in commit 3) ────────
  server.post(
    "/indexer/arch/faucet/airdrop",
    {
      schema: {
        summary: "Request testnet airdrop (proxied)",
        tags: ["indexer"],
        body: FaucetBody,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { address } = request.body as { address: string };
      const result = await forward(reply, () =>
        indexer.requestFaucetAirdrop(address),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  // ── Bitcoin (reads) ────────────────────────────────────────────
  server.get(
    "/indexer/btc/address/:address",
    {
      schema: {
        summary: "BTC address summary (proxied)",
        tags: ["indexer"],
        params: AddressParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { address } = request.params as { address: string };
      const result = await forward(reply, () =>
        indexer.getBtcAddressSummary(address),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  server.get(
    "/indexer/btc/address/:address/utxo",
    {
      schema: {
        summary: "BTC address UTXOs (proxied)",
        tags: ["indexer"],
        params: AddressParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { address } = request.params as { address: string };
      const result = await forward(reply, () =>
        indexer.getBtcAddressUtxos(address),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  server.get(
    "/indexer/btc/address/:address/txs",
    {
      schema: {
        summary: "BTC address transactions (proxied)",
        tags: ["indexer"],
        params: AddressParam,
        querystring: BtcTxsQuery,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { address } = request.params as { address: string };
      const { after_txid } = request.query as { after_txid?: string };
      const result = await forward(reply, () =>
        indexer.getBtcAddressTxs(address, after_txid),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  server.get(
    "/indexer/btc/tx/:txid",
    {
      schema: {
        summary: "BTC transaction detail (proxied)",
        tags: ["indexer"],
        params: TxidParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { txid } = request.params as { txid: string };
      const result = await forward(reply, () =>
        indexer.getBtcTransaction(txid),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  server.get(
    "/indexer/btc/tx/:txid/status",
    {
      schema: {
        summary: "BTC transaction status (proxied)",
        tags: ["indexer"],
        params: TxidParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { txid } = request.params as { txid: string };
      const result = await forward(reply, () =>
        indexer.getBtcTransactionStatus(txid),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  server.get(
    "/indexer/btc/fee-estimates",
    {
      schema: {
        summary: "BTC fee estimates (proxied)",
        tags: ["indexer"],
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const result = await forward(reply, () => indexer.getBtcFeeEstimates());
      if (result !== undefined) reply.send(result);
    },
  );

  server.get(
    "/indexer/btc/tip",
    {
      schema: {
        summary: "BTC chain tip (proxied)",
        tags: ["indexer"],
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const result = await forward(reply, () => indexer.getBtcChainTip());
      if (result !== undefined) reply.send(result);
    },
  );

  // ── Bitcoin (broadcast; audit hookup follows in commit 3) ──────
  server.post(
    "/indexer/btc/tx",
    {
      schema: {
        summary: "Broadcast BTC raw transaction (proxied)",
        tags: ["indexer"],
        body: BroadcastBody,
        response: { 200: BroadcastResponse },
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { rawTxHex } = request.body as { rawTxHex: string };
      const txid = await forward(reply, () =>
        indexer.broadcastBtcTransaction(rawTxHex),
      );
      if (txid !== undefined) reply.send({ txid: String(txid).trim() });
    },
  );
};
