import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import { withDbTransaction } from "../db/tx.js";
import { getDbPool } from "../db/pool.js";
import { auditEvent } from "../audit/audit.js";
import { Verifier, Address as Bip322Address } from "@saturnbtcio/bip322-js";
import { resolveArchAccountAddress, archAccountFromWalletPublicKey } from "../arch/address.js";
import { getIndexerClient } from "../indexer/store.js";
import { getOrCreateUserByExternalId } from "../db/apps.js";

const CreateChallengeBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  walletProvider: Type.String({ minLength: 1 }),
  address: Type.String({ minLength: 1 }),
  network: Type.Optional(Type.String({ minLength: 1 })),
  // Wallet's public key (compressed 33-byte or x-only 32-byte hex, e.g. from
  // Unisat's getPublicKey()). REQUIRED for the canonical Arch identity: the
  // Arch account key is the UNTWEAKED internal x-only pubkey, which cannot be
  // recovered from the taproot address. Optional only for backwards
  // compatibility with older clients (which fall back to the legacy
  // address-decoded/tweaked derivation).
  publicKeyHex: Type.Optional(Type.String({ pattern: "^[0-9a-fA-F]{64}([0-9a-fA-F]{2})?$" }))
});

const CreateChallengeResponse = Type.Object({
  challengeId: Type.String(),
  message: Type.String(),
  expiresAt: Type.String()
});

const VerifyChallengeBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  challengeId: Type.String({ minLength: 1 }),
  signature: Type.String({ minLength: 1 }),
  schemeHint: Type.Optional(
    Type.Union([Type.Literal("bip322"), Type.Literal("wallet_specific")])
  )
});

const VerifyChallengeResponse = Type.Object({
  linkedWalletId: Type.String(),
  address: Type.String(),
  archAccountAddress: Type.String(),
  walletProvider: Type.String(),
  verificationScheme: Type.String()
});

const ListLinkedWalletsQuery = Type.Object({
  externalUserId: Type.String({ minLength: 1 })
});

const ListLinkedWalletsResponse = Type.Array(
  Type.Object({
    id: Type.String(),
    walletProvider: Type.String(),
    address: Type.String(),
    archAccountAddress: Type.String(),
    network: Type.String(),
    createdAt: Type.String()
  })
);

const AddressParams = Type.Object({
  address: Type.String({ minLength: 1 })
});

const AccountSummaryResponse = Type.Object({
  address: Type.String(),
  resolvedArchAccountAddress: Type.String(),
  account: Type.Unknown()
});

const AccountTransactionsResponse = Type.Object({
  address: Type.String(),
  resolvedArchAccountAddress: Type.String(),
  transactions: Type.Unknown()
});

type Network = "mainnet" | "testnet" | "signet" | "regtest";

function inferNetworkFromAddress(address: string): Network {
  // Keep it conservative; we can refine when we formalize network support.
  // - bc1 / 1 / 3 => mainnet
  // - tb1 / m / n / 2 => testnet (also used by signet in some contexts)
  // - bcrt1 => regtest
  if (address.startsWith("bcrt1")) return "regtest";
  if (address.startsWith("tb1") || address.startsWith("m") || address.startsWith("n") || address.startsWith("2")) {
    return "testnet";
  }
  return "mainnet";
}

function makeChallengeMessage(params: { domain: string; address: string; nonce: string; expiresAtIso: string }) {
  // Explicit and auditable. Wallets will sign this string.
  return [
    `${params.domain} wants you to prove ownership of this Bitcoin address:`,
    params.address,
    "",
    `Nonce: ${params.nonce}`,
    `Expires: ${params.expiresAtIso}`,
    "",
    "Only sign this message if you trust the application."
  ].join("\n");
}

export const registerWalletLinkingRoutes: FastifyPluginAsync = async (server) => {
  // Phase 1 note: we accept userId as input (placeholder for real auth).
  server.post(
    "/wallet-links/challenge",
    {
      preHandler: server.enforceSessionForRoute("wallet-links.challenge"),
      schema: {
        summary: "Create a wallet-linking challenge",
        tags: ["wallet-linking"],
        body: CreateChallengeBody,
        response: { 200: CreateChallengeResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const db = getDbPool();
      const body = request.body as any;
      const externalUserId: string = body.externalUserId;
      const walletProvider: string = body.walletProvider;
      const address: string = body.address;
      const publicKeyHex: string | undefined = body.publicKeyHex
        ? String(body.publicKeyHex).toLowerCase()
        : undefined;

      if (!Bip322Address.isValidBitcoinAddress(address)) {
        return reply.badRequest("Invalid bitcoin address");
      }
      if (!Bip322Address.isP2TR(address)) {
        return reply.badRequest("Only Taproot (p2tr) addresses are supported");
      }

      // Canonical Arch identity = untweaked internal x-only key. When the
      // client supplies the wallet's public key we verify it corresponds to
      // the address (BIP-341 tweak check) and reject on mismatch: registering
      // an unproven key would be worse than the legacy behaviour.
      let canonical: { internalXOnlyHex: string; archAccountAddress: string } | null = null;
      if (publicKeyHex) {
        const derived = archAccountFromWalletPublicKey({ publicKeyHex, taprootAddress: address });
        if (!derived.ok) {
          return reply.badRequest(`Invalid publicKeyHex: ${derived.reason}`);
        }
        canonical = derived;
      }

      const network: Network = body.network ?? inferNetworkFromAddress(address);
      // Legacy fallback for clients that do not send publicKeyHex: the
      // address-decoded key is TWEAKED and therefore the WRONG Arch identity,
      // but breaking older clients' linking outright is worse; they migrate
      // on their next link once updated.
      const resolvedArchAccountAddress =
        canonical?.archAccountAddress ?? resolveArchAccountAddress(address).archAccountAddress;
      if (!canonical) {
        request.log.warn(
          { walletProvider, address },
          "wallet-link challenge without publicKeyHex: falling back to legacy (tweaked) Arch identity derivation"
        );
      }
      const nonce = crypto.randomBytes(16).toString("hex");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
      const message = makeChallengeMessage({
        domain: "arch-wallet-hub",
        address,
        nonce,
        expiresAtIso: expiresAt.toISOString()
      });

      const row = await withDbTransaction(db, async (client) => {
        const user = await getOrCreateUserByExternalId(client, { appId, externalUserId });
        const res = await client.query<{ id: string; expires_at: string }>(
          `
          INSERT INTO wallet_link_challenges (app_id, user_id, wallet_provider, address, challenge, expires_at, public_key_hex)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          RETURNING id, expires_at
          `,
          [appId, user.id, walletProvider, address, message, expiresAt.toISOString(), publicKeyHex ?? null]
        );
        await auditEvent({
          client,
          requestId: request.id,
          appId,
          userId: user.id,
          eventType: "wallet_link.challenge.created",
          entityType: "wallet_link_challenge",
          entityId: res.rows[0]!.id,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: {
            walletProvider,
            address,
            network,
            resolvedArchAccountAddress,
            derivation: canonical ? "internal_key" : "legacy_address_decode",
            expiresAt: expiresAt.toISOString()
          },
          outcome: "succeeded"
        });
        return res.rows[0]!;
      });

      return { challengeId: row.id, message, expiresAt: row.expires_at };
    }
  );

  server.post(
    "/wallet-links/verify",
    {
      preHandler: server.enforceSessionForRoute("wallet-links.verify"),
      schema: {
        summary: "Verify a signed challenge and link the wallet address",
        tags: ["wallet-linking"],
        body: VerifyChallengeBody,
        response: { 200: VerifyChallengeResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const db = getDbPool();
      const body = request.body as any;
      const externalUserId: string = body.externalUserId;
      const challengeId: string = body.challengeId;
      const signature: string = body.signature;

      const user = await withDbTransaction(db, (client) =>
        getOrCreateUserByExternalId(client, { appId, externalUserId })
      );

      const record = await withDbTransaction(db, async (client) => {
        const res = await client.query<{
          id: string;
          app_id: string;
          user_id: string;
          wallet_provider: string;
          address: string;
          challenge: string;
          expires_at: string;
          used_at: string | null;
          public_key_hex: string | null;
        }>(
          `SELECT * FROM wallet_link_challenges WHERE id = $1 AND app_id = $2`,
          [challengeId, appId]
        );
        return res.rows[0] ?? null;
      });

      if (!record) return reply.notFound("Unknown challengeId");
      if (record.user_id !== user.id) return reply.forbidden("Challenge does not belong to user");
      if (record.used_at) return reply.conflict("Challenge already used");
      if (new Date(record.expires_at).getTime() < Date.now()) return reply.gone("Challenge expired");

      // Phase 1 requirement: accept both BIP-322 and wallet-specific message signing.
      // bip322-js Verifier.verifySignature supports BIP-322 and loosely recognizes legacy message signatures too.
      let verificationScheme: "bip322" | "bip137" | "wallet_specific" = "bip322";
      let ok = false;
      try {
        ok = Verifier.verifySignature(record.address, record.challenge, signature);
        // The library abstracts over BIP-322 vs legacy; we store a conservative scheme label.
        verificationScheme = body.schemeHint ?? "wallet_specific";
      } catch (e) {
        ok = false;
      }

      if (!ok) return reply.unauthorized("Signature verification failed");

      const network = inferNetworkFromAddress(record.address);

      // Canonical Arch identity: derive from the wallet's UNTWEAKED internal
      // pubkey captured at challenge time (verified against the address via
      // the BIP-341 tweak check). Legacy fallback (no pubkey): the
      // address-decoded TWEAKED key — kept only so older clients can still
      // link; they self-heal on their next link after updating.
      const canonical = record.public_key_hex
        ? archAccountFromWalletPublicKey({
            publicKeyHex: record.public_key_hex,
            taprootAddress: record.address
          })
        : null;
      if (canonical && !canonical.ok) {
        // Should be unreachable: the challenge endpoint validated this pair.
        return reply.badRequest(`Invalid publicKeyHex on challenge: ${canonical.reason}`);
      }
      const archAccountAddress = canonical?.ok
        ? canonical.archAccountAddress
        : resolveArchAccountAddress(record.address).archAccountAddress;
      if (!canonical) {
        request.log.warn(
          { walletProvider: record.wallet_provider, address: record.address },
          "wallet-link verify without publicKeyHex: registering legacy (tweaked) Arch identity"
        );
      }

      const linked = await withDbTransaction(db, async (client) => {
        await client.query(`UPDATE wallet_link_challenges SET used_at = NOW() WHERE id = $1`, [
          challengeId
        ]);

        // Migration path for links registered under the tweaked key: preserve
        // the previous mapping in legacy_arch_account_address (first value
        // wins; never overwritten, never deleted) and leave an audit event.
        // Idempotent: re-linking with the same canonical key changes nothing.
        const existing = await client.query<{ id: string; arch_account_address: string | null }>(
          `SELECT id, arch_account_address FROM linked_wallets
           WHERE user_id = $1 AND wallet_provider = $2 AND address = $3`,
          [user.id, record.wallet_provider, record.address]
        );
        const previousArchAccountAddress = existing.rows[0]?.arch_account_address ?? null;
        const isIdentityMigration =
          previousArchAccountAddress !== null && previousArchAccountAddress !== archAccountAddress;

        const res = await client.query<{ id: string }>(
          `
          INSERT INTO linked_wallets (app_id, user_id, wallet_provider, address, arch_account_address, network, verification_scheme, signature, message, public_key_hex)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (user_id, wallet_provider, address) DO UPDATE
            SET signature = EXCLUDED.signature,
                message = EXCLUDED.message,
                verification_scheme = EXCLUDED.verification_scheme,
                arch_account_address = EXCLUDED.arch_account_address,
                public_key_hex = COALESCE(EXCLUDED.public_key_hex, linked_wallets.public_key_hex),
                legacy_arch_account_address = CASE
                  WHEN linked_wallets.arch_account_address IS DISTINCT FROM EXCLUDED.arch_account_address
                    THEN COALESCE(linked_wallets.legacy_arch_account_address, linked_wallets.arch_account_address)
                  ELSE linked_wallets.legacy_arch_account_address
                END
          RETURNING id
          `,
          [
            appId,
            user.id,
            record.wallet_provider,
            record.address,
            archAccountAddress,
            network,
            verificationScheme,
            signature,
            record.challenge,
            record.public_key_hex ?? null
          ]
        );

        if (isIdentityMigration) {
          await auditEvent({
            client,
            requestId: request.id,
            appId,
            userId: user.id,
            eventType: "wallet_link.arch_identity_migrated",
            entityType: "linked_wallet",
            entityId: res.rows[0]!.id,
            turnkeyActivityId: null,
            turnkeyRequestId: null,
            payloadJson: {
              walletProvider: record.wallet_provider,
              address: record.address,
              previousArchAccountAddress,
              archAccountAddress,
              derivation: canonical?.ok ? "internal_key" : "legacy_address_decode"
            },
            outcome: "succeeded"
          });
        }

        await auditEvent({
          client,
          requestId: request.id,
          appId,
          userId: user.id,
          eventType: "wallet_link.verified",
          entityType: "linked_wallet",
          entityId: res.rows[0]!.id,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: {
            walletProvider: record.wallet_provider,
            address: record.address,
            network,
            verificationScheme,
            archAccountAddress,
            derivation: canonical?.ok ? "internal_key" : "legacy_address_decode"
          },
          outcome: "succeeded"
        });

        return res.rows[0]!;
      });

      return {
        linkedWalletId: linked.id,
        address: record.address,
        archAccountAddress,
        walletProvider: record.wallet_provider,
        verificationScheme
      };
    }
  );

  server.get(
    "/wallet-links",
    {
      preHandler: server.enforceSessionForRoute("wallet-links.list"),
      schema: {
        summary: "List linked wallets",
        tags: ["wallet-linking"],
        querystring: ListLinkedWalletsQuery,
        response: { 200: ListLinkedWalletsResponse }
      }
    },
    async (request) => {
      const appId = (request as any).app?.appId;
      if (!appId) throw new Error("Missing app context");

      const db = getDbPool();
      const { externalUserId } = request.query as any;
      const user = await withDbTransaction(db, (client) =>
        getOrCreateUserByExternalId(client, { appId, externalUserId })
      );
      const rows = await withDbTransaction(db, async (client) => {
        const res = await client.query<{
          id: string;
          wallet_provider: string;
          address: string;
          arch_account_address: string | null;
          network: string;
          created_at: string;
        }>(
          `SELECT id, wallet_provider, address, arch_account_address, network, created_at FROM linked_wallets WHERE app_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
          [appId, user.id]
        );
        return res.rows;
      });
      return rows.map((r) => ({
        id: r.id,
        walletProvider: r.wallet_provider,
        address: r.address,
        archAccountAddress:
          r.arch_account_address ?? resolveArchAccountAddress(r.address).archAccountAddress,
        network: r.network,
        createdAt: r.created_at
      }));
    }
  );

  // View-only indexer passthrough (Phase 1)
  server.get(
    "/arch/accounts/:address",
    {
      schema: {
        summary: "Get Arch account summary from indexer (view-only)",
        tags: ["indexer"],
        params: AddressParams,
        response: { 200: AccountSummaryResponse }
      }
    },
    async (request, reply) => {
      const indexer = getIndexerClient();
      if (!indexer) return reply.notImplemented("Indexer not configured");
      const { address } = request.params as any;
      const resolved = resolveArchAccountAddress(address);
      const account = await indexer.getAccountSummary(resolved.archAccountAddress);
      return { address, resolvedArchAccountAddress: resolved.archAccountAddress, account };
    }
  );

  server.get(
    "/arch/accounts/:address/transactions",
    {
      schema: {
        summary: "Get Arch account transactions from indexer (view-only)",
        tags: ["indexer"],
        params: AddressParams,
        response: { 200: AccountTransactionsResponse }
      }
    },
    async (request, reply) => {
      const indexer = getIndexerClient();
      if (!indexer) return reply.notImplemented("Indexer not configured");
      const { address } = request.params as any;
      const resolved = resolveArchAccountAddress(address);
      const transactions = await indexer.getAccountTransactions(resolved.archAccountAddress);
      return { address, resolvedArchAccountAddress: resolved.archAccountAddress, transactions };
    }
  );
};
