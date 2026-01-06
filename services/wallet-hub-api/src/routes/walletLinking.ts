import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import { withDbTransaction } from "../db/tx.js";
import { auditEvent } from "../audit/audit.js";
import { Verifier, Address as Bip322Address } from "@saturnbtcio/bip322-js";

const CreateChallengeBody = Type.Object({
  userId: Type.String({ minLength: 1 }),
  walletProvider: Type.String({ minLength: 1 }),
  address: Type.String({ minLength: 1 }),
  network: Type.Optional(Type.String({ minLength: 1 }))
});

const CreateChallengeResponse = Type.Object({
  challengeId: Type.String(),
  message: Type.String(),
  expiresAt: Type.String()
});

const VerifyChallengeBody = Type.Object({
  userId: Type.String({ minLength: 1 }),
  challengeId: Type.String({ minLength: 1 }),
  signature: Type.String({ minLength: 1 }),
  schemeHint: Type.Optional(
    Type.Union([Type.Literal("bip322"), Type.Literal("wallet_specific")])
  )
});

const VerifyChallengeResponse = Type.Object({
  linkedWalletId: Type.String(),
  address: Type.String(),
  walletProvider: Type.String(),
  verificationScheme: Type.String()
});

const ListLinkedWalletsQuery = Type.Object({
  userId: Type.String({ minLength: 1 })
});

const ListLinkedWalletsResponse = Type.Array(
  Type.Object({
    id: Type.String(),
    walletProvider: Type.String(),
    address: Type.String(),
    network: Type.String(),
    createdAt: Type.String()
  })
);

const AddressParams = Type.Object({
  address: Type.String({ minLength: 1 })
});

const AccountSummaryResponse = Type.Object({
  address: Type.String(),
  account: Type.Unknown()
});

const AccountTransactionsResponse = Type.Object({
  address: Type.String(),
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
      schema: {
        summary: "Create a wallet-linking challenge",
        tags: ["wallet-linking"],
        body: CreateChallengeBody,
        response: { 200: CreateChallengeResponse }
      }
    },
    async (request, reply) => {
      const body = request.body as any;
      const userId: string = body.userId;
      const walletProvider: string = body.walletProvider;
      const address: string = body.address;

      if (!Bip322Address.isValidBitcoinAddress(address)) {
        return reply.badRequest("Invalid bitcoin address");
      }

      const network: Network = body.network ?? inferNetworkFromAddress(address);
      const nonce = crypto.randomBytes(16).toString("hex");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
      const message = makeChallengeMessage({
        domain: "arch-wallet-hub",
        address,
        nonce,
        expiresAtIso: expiresAt.toISOString()
      });

      const row = await withDbTransaction(server.db, async (client) => {
        const res = await client.query<{ id: string; expires_at: string }>(
          `
          INSERT INTO wallet_link_challenges (user_id, wallet_provider, address, challenge, expires_at)
          VALUES ($1,$2,$3,$4,$5)
          RETURNING id, expires_at
          `,
          [userId, walletProvider, address, message, expiresAt.toISOString()]
        );
        await auditEvent({
          client,
          requestId: request.id,
          userId,
          eventType: "wallet_link.challenge.created",
          entityType: "wallet_link_challenge",
          entityId: res.rows[0]!.id,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: { walletProvider, address, network, expiresAt: expiresAt.toISOString() },
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
      schema: {
        summary: "Verify a signed challenge and link the wallet address",
        tags: ["wallet-linking"],
        body: VerifyChallengeBody,
        response: { 200: VerifyChallengeResponse }
      }
    },
    async (request, reply) => {
      const body = request.body as any;
      const userId: string = body.userId;
      const challengeId: string = body.challengeId;
      const signature: string = body.signature;

      const record = await withDbTransaction(server.db, async (client) => {
        const res = await client.query<{
          id: string;
          user_id: string;
          wallet_provider: string;
          address: string;
          challenge: string;
          expires_at: string;
          used_at: string | null;
        }>(
          `SELECT * FROM wallet_link_challenges WHERE id = $1`,
          [challengeId]
        );
        return res.rows[0] ?? null;
      });

      if (!record) return reply.notFound("Unknown challengeId");
      if (record.user_id !== userId) return reply.forbidden("Challenge does not belong to user");
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

      const linked = await withDbTransaction(server.db, async (client) => {
        await client.query(`UPDATE wallet_link_challenges SET used_at = NOW() WHERE id = $1`, [
          challengeId
        ]);
        const res = await client.query<{ id: string }>(
          `
          INSERT INTO linked_wallets (user_id, wallet_provider, address, network, verification_scheme, signature, message)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (user_id, wallet_provider, address) DO UPDATE
            SET signature = EXCLUDED.signature,
                message = EXCLUDED.message,
                verification_scheme = EXCLUDED.verification_scheme
          RETURNING id
          `,
          [userId, record.wallet_provider, record.address, network, verificationScheme, signature, record.challenge]
        );

        await auditEvent({
          client,
          requestId: request.id,
          userId,
          eventType: "wallet_link.verified",
          entityType: "linked_wallet",
          entityId: res.rows[0]!.id,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: { walletProvider: record.wallet_provider, address: record.address, network, verificationScheme },
          outcome: "succeeded"
        });

        return res.rows[0]!;
      });

      return {
        linkedWalletId: linked.id,
        address: record.address,
        walletProvider: record.wallet_provider,
        verificationScheme
      };
    }
  );

  server.get(
    "/wallet-links",
    {
      schema: {
        summary: "List linked wallets",
        tags: ["wallet-linking"],
        querystring: ListLinkedWalletsQuery,
        response: { 200: ListLinkedWalletsResponse }
      }
    },
    async (request) => {
      const { userId } = request.query as any;
      const rows = await withDbTransaction(server.db, async (client) => {
        const res = await client.query<{
          id: string;
          wallet_provider: string;
          address: string;
          network: string;
          created_at: string;
        }>(`SELECT id, wallet_provider, address, network, created_at FROM linked_wallets WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
        return res.rows;
      });
      return rows.map((r) => ({
        id: r.id,
        walletProvider: r.wallet_provider,
        address: r.address,
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
      if (!server.indexer) return reply.notImplemented("Indexer not configured");
      const { address } = request.params as any;
      const account = await server.indexer.getAccountSummary(address);
      return { address, account };
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
      if (!server.indexer) return reply.notImplemented("Indexer not configured");
      const { address } = request.params as any;
      const transactions = await server.indexer.getAccountTransactions(address);
      return { address, transactions };
    }
  );
};
