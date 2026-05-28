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
import { createHash } from "node:crypto";
import { indexerForRequest, requestNetwork } from "../indexer/forRequest.js";
import type { IndexerClient } from "../indexer/client.js";
import { auditEvent } from "../audit/audit.js";
import { getDbPool } from "../db/pool.js";
import { withDbTransaction } from "../db/tx.js";

/**
 * Extract + validate the wallet's installation id.
 *
 * The chrome extension persists a UUID v4 in chrome.storage.local
 * (key `arch_wallet_install_id`) and sends it on every Hub call.
 * It's NOT a secret -- it's a stable rate-limit dimension, the
 * same role MetaMask's per-install header plays at Infura.
 *
 * Validation rules:
 *   - Must look like a UUID. Anything else is rejected and treated
 *     as "no install id" (falls back to app-key-only rate limit).
 *   - We deliberately don't enforce v4 specifics: a future client
 *     migration to v7 or random-128 shouldn't require a Hub deploy.
 *
 * Why the format check: without one, a misbehaving client could
 * randomize the header per request and effectively bypass the
 * per-install rate limit. UUIDs are stable per install by
 * construction; random strings that happen to LOOK like UUIDs are
 * exactly as bypass-able, so we don't try to defend against that
 * here -- abuse beyond the format check belongs in a higher tier
 * (WAF / behavioral detection on traffic patterns).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getInstallId(req: FastifyRequest): string | null {
  const raw = req.headers["x-arch-install-id"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!UUID_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Compose the rate-limit key for indexer-proxy routes.
 *
 *   `app:<apiKeyId>:install:<installId>`  — preferred
 *   `app:<apiKeyId>:install:none`         — when no/invalid install id
 *   `ip:<ip>`                             — completely unauthenticated
 *                                           (shouldn't happen here
 *                                           because requireAppAuth
 *                                           rejects first, but the
 *                                           fallback keeps
 *                                           keyGenerator total)
 *
 * We do NOT differentiate the cap by install-id presence in v1.
 * Production wallet builds always send the id; a one-tier cap is
 * simpler and avoids weird edge cases with local-dev builds.
 */
function rateLimitKey(req: FastifyRequest): string {
  const apiKeyId = req.app?.apiKeyId;
  if (!apiKeyId) return `ip:${req.ip}`;
  const installId = getInstallId(req);
  return `app:${apiKeyId}:install:${installId ?? "none"}`;
}

/**
 * Per-installation rate limit applied to every route registered by
 * this plugin. Replaces the global 300/min/key cap on these
 * routes: a popular app with 100 active wallet installs each doing
 * one Dashboard refresh per minute (~15 reads) would otherwise
 * blow past 300/min/key in seconds. With the per-install
 * dimension, 100 installs * 15 reads = 1500 reads/min are 100
 * separate buckets of 15 -- well under the 120/min cap.
 *
 * 120/min/install picked from:
 *   - Dashboard refresh ~10-15 reads.
 *   - Typical UI: 1-2 refreshes/min during normal use.
 *   - Heavy use (e.g. swap flows polling fee estimates):
 *     ~30-60 reads/min.
 *
 * Tuning knob if telemetry says otherwise: raise on the route
 * config in a follow-up.
 */
const INDEXER_RATE_LIMIT = {
  rateLimit: {
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: rateLimitKey,
  },
};

/**
 * Audit a state-mutating proxy call.
 *
 * Best-effort: if the audit insert throws (DB blip), we log the
 * failure and swallow. Reasoning -- the upstream Indexer has
 * already broadcast the tx / issued the airdrop; rolling back the
 * caller's response to ROLLBACK the audit would leave the user
 * with a "failed" response for an action that already happened.
 * That's a worse outcome than a chain gap; the gap is detectable
 * by the verifier and explainable from server logs.
 *
 * Once PR #15 (HMAC audit chain) merges, this function continues
 * to work unchanged: the chain wiring lives inside auditEvent /
 * insertAuditLog, so call sites stay clean.
 *
 * payloadJson contracts:
 *   - Faucet: { address, network }
 *   - Broadcast: { rawTxHash, network, txid? }   -- NEVER the full
 *     rawTxHex; that would log transaction details (recipient,
 *     amount) into the audit log. We log the sha256 hash so the
 *     verifier can correlate the audit row to a specific broadcast
 *     attempt without exposing wallet activity.
 */
async function auditMutatingCall(
  server: import("fastify").FastifyInstance,
  request: FastifyRequest,
  params: {
    eventType: string;
    entityType: string;
    entityId: string | null;
    payloadJson: Record<string, unknown>;
    outcome: "succeeded" | "failed";
  },
): Promise<void> {
  try {
    const appId = request.app?.appId;
    if (!appId) return;
    const db = getDbPool();
    await withDbTransaction(db, (client) =>
      auditEvent({
        client,
        appId,
        requestId: request.id ? String(request.id) : null,
        userId: null, // proxy reads are app-scoped, not user-scoped
        eventType: params.eventType,
        entityType: params.entityType,
        entityId: params.entityId,
        turnkeyActivityId: null,
        turnkeyRequestId: null,
        payloadJson: params.payloadJson,
        outcome: params.outcome,
      }),
    );
  } catch (err: any) {
    server.log.error(
      { err: err?.message, eventType: params.eventType },
      "indexer proxy audit insert failed",
    );
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

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

const BlockHashParam = Type.Object({
  hash: Type.String({
    minLength: 64,
    maxLength: 64,
    pattern: "^[0-9a-fA-F]{64}$",
  }),
});

// Height is a uint32 in Bitcoin (last block ~2026 is ~870_000; cap
// at 2^31 to leave room and reject obvious garbage early).
const BlockHeightParam = Type.Object({
  height: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
});

// JSON-RPC compat body. We accept `method` + `params` only; the
// envelope (`jsonrpc`, `id`) is constructed server-side. Method
// names are bounded to avoid pathological / SSRF-via-method-name
// attempts; the upstream indexer also validates against its own
// allowlist, but defense-in-depth here keeps obviously-bad
// requests from ever hitting upstream.
const ArchRpcBody = Type.Object({
  method: Type.String({ minLength: 1, maxLength: 128 }),
  params: Type.Unknown(),
});

export const registerIndexerRoutes: FastifyPluginAsync = async (server) => {
  // Apply the per-installation rate-limit config to EVERY route
  // registered in this plugin scope. onRoute is mutate-in-place
  // and runs at registration time, so the per-route config
  // overrides the global rate-limit defaults for these routes
  // only. Encapsulated via fastify-plugin's default scoping --
  // other route modules (signing-requests, turnkey, etc.) are
  // unaffected.
  server.addHook("onRoute", (routeOptions) => {
    routeOptions.config = {
      ...(routeOptions.config ?? {}),
      ...INDEXER_RATE_LIMIT,
    };
  });

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

  // Richer v2 transactions endpoint -- returns chip labels,
  // programs, fee_payer, etc. The wallet History tab prefers
  // this over the legacy /transactions response.
  server.get(
    "/indexer/arch/accounts/:address/transactions/v2",
    {
      schema: {
        summary: "Get Arch account transactions v2 (proxied)",
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
        indexer.getAccountTransactionsV2(address, limit, page),
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

  // Flat list of top-level instructions on a transaction. The
  // wallet's swap inspector uses this when the instruction tree
  // doesn't decode an inner Token: Transfer but the top-level
  // call witnesses the action.
  server.get(
    "/indexer/arch/transactions/:txid/instructions",
    {
      schema: {
        summary: "Get Arch transaction instructions (proxied)",
        tags: ["indexer"],
        params: TxidParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { txid } = request.params as { txid: string };
      const result = await forward(reply, () =>
        indexer.getTransactionInstructions(txid),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  // Full instruction tree with CPI children. Primary signal source
  // for AMM/router swap detection (the actual Token: Transfer
  // typically lives inside a custom program's top-level call).
  server.get(
    "/indexer/arch/transactions/:txid/tree",
    {
      schema: {
        summary: "Get Arch transaction instruction tree (proxied)",
        tags: ["indexer"],
        params: TxidParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { txid } = request.params as { txid: string };
      const result = await forward(reply, () =>
        indexer.getTransactionTree(txid),
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

  // ── Faucet (mutating; audited) ─────────────────────────────────
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
      const network = requestNetwork(request);
      try {
        const result = await indexer.requestFaucetAirdrop(address);
        await auditMutatingCall(server, request, {
          eventType: "indexer_faucet_airdrop",
          entityType: "arch_account",
          entityId: address,
          payloadJson: { address, network },
          outcome: "succeeded",
        });
        reply.send(result);
      } catch (err: any) {
        await auditMutatingCall(server, request, {
          eventType: "indexer_faucet_airdrop",
          entityType: "arch_account",
          entityId: address,
          payloadJson: { address, network, error: err?.message ?? String(err) },
          outcome: "failed",
        });
        reply.code(502).send({
          statusCode: 502,
          error: "BadGateway",
          message: err?.message ?? "Faucet airdrop failed",
        });
      }
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

  // Block header lookup by hash. Used by the wallet to resolve
  // confirmation timestamps without a second round-trip to a
  // public BTC API.
  server.get(
    "/indexer/btc/block/:hash",
    {
      schema: {
        summary: "BTC block detail (proxied)",
        tags: ["indexer"],
        params: BlockHashParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { hash } = request.params as { hash: string };
      const result = await forward(reply, () => indexer.getBtcBlock(hash));
      if (result !== undefined) reply.send(result);
    },
  );

  // Block hash lookup by height. Companion to /block/:hash:
  // wallet pulls (height -> hash -> header.time) to label
  // confirmed BTC txns with a wall-clock timestamp.
  server.get(
    "/indexer/btc/block-height/:height",
    {
      schema: {
        summary: "BTC block hash at height (proxied)",
        tags: ["indexer"],
        params: BlockHeightParam,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { height } = request.params as { height: number };
      const result = await forward(reply, () =>
        indexer.getBtcBlockHashAtHeight(height),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  // ── Arch JSON-RPC compat ───────────────────────────────────────
  // Forwards `{ method, params }` to the upstream indexer's `/rpc`
  // endpoint. Server-side wraps in the JSON-RPC envelope and
  // unwraps `.result` -- the wallet sees a plain result on success
  // or a thrown error on JSON-RPC `.error`, just like every other
  // method.
  //
  // Why POST: matches the upstream's verb. Also lets us reject
  // oversized `params` bodies via Fastify's bodyLimit instead of
  // long-URL games on GET.
  //
  // Not audited: this is a read path for things like
  // `read_account_info` -- the audit chain is reserved for
  // mutating calls (faucet, broadcast).
  server.post(
    "/indexer/arch/rpc",
    {
      schema: {
        summary: "Arch JSON-RPC compat (proxied)",
        tags: ["indexer"],
        body: ArchRpcBody,
      },
    },
    async (request, reply) => {
      const indexer = indexerOr501(request, reply);
      if (!indexer) return;
      const { method, params } = request.body as {
        method: string;
        params: unknown;
      };
      const result = await forward(reply, () =>
        indexer.archRpc(method, params),
      );
      if (result !== undefined) reply.send(result);
    },
  );

  // ── Bitcoin (broadcast; audited) ───────────────────────────────
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
      const network = requestNetwork(request);
      const rawTxHash = sha256Hex(rawTxHex);
      try {
        const txidRaw = await indexer.broadcastBtcTransaction(rawTxHex);
        const txid = String(txidRaw).trim();
        await auditMutatingCall(server, request, {
          eventType: "indexer_btc_broadcast",
          entityType: "btc_tx",
          entityId: txid || null,
          payloadJson: { rawTxHash, network, txid },
          outcome: "succeeded",
        });
        reply.send({ txid });
      } catch (err: any) {
        await auditMutatingCall(server, request, {
          eventType: "indexer_btc_broadcast",
          entityType: "btc_tx",
          entityId: null,
          payloadJson: {
            rawTxHash,
            network,
            error: err?.message ?? String(err),
          },
          outcome: "failed",
        });
        reply.code(502).send({
          statusCode: 502,
          error: "BadGateway",
          message: err?.message ?? "BTC broadcast failed",
        });
      }
    },
  );
};
