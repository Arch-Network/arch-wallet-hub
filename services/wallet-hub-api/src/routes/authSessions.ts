/**
 * Session-token endpoints.
 *
 *   POST /v1/auth/session/challenge
 *     Body: { externalUserId, turnkeyResourceId }
 *     Returns a one-shot challenge the client must sign with the
 *     resource's default Taproot xOnly key.
 *
 *   POST /v1/auth/session
 *     Body: { challengeId, signatureHex }
 *     Verifies the schnorr signature over the challenge's payload
 *     against the resource's stored `default_public_key_hex` and
 *     mints a session token.
 *
 *   POST /v1/auth/session/revoke
 *     Requires Bearer. Marks the current session revoked.
 *
 * All three are app-auth-gated (x-api-key) the same way the rest
 * of the API is; the mint flow's actual security comes from the
 * challenge-signature handshake.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import { Address as Bip322Address } from "@saturnbtcio/bip322-js";
import { withDbTransaction } from "../db/tx.js";
import { getDbPool } from "../db/pool.js";
import { getOrCreateUserByExternalId } from "../db/apps.js";
import {
  getLinkedWalletForUser,
  getTurnkeyResourceByIdForApp,
  markTurnkeyResourceKeyVerifiedForApp,
  type TurnkeyResourceRow,
} from "../db/queries.js";
import { getTurnkeyClient } from "../turnkey/store.js";
import { findTurnkeyWalletAccount } from "../turnkey/walletAccountVerification.js";
import { setDefaultRateLimitGroup } from "../plugins/rateLimit.js";
import {
  createChallenge,
  createExternalChallenge,
  loadConsumableChallenge,
  mintSession,
  revokeSession,
  verifyChallengeSignature,
  verifyExternalChallengeSignature,
} from "../auth/sessionToken.js";

const ChallengeBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  // `turnkey_resources.id` is a Postgres uuid column. Constrain the input to
  // a UUID so a malformed id is rejected with a clean 400 by the schema
  // validator instead of reaching the DB and surfacing as a 22P02 500.
  turnkeyResourceId: Type.String({ format: "uuid" }),
});

const ChallengeResponse = Type.Object({
  challengeId: Type.String(),
  message: Type.String(),
  payloadHex: Type.String(),
  expiresAt: Type.String(),
});

const MintBody = Type.Object({
  challengeId: Type.String({ minLength: 1 }),
  signatureHex: Type.String({ minLength: 1 }),
});

const MintResponse = Type.Object({
  sessionToken: Type.String(),
  expiresAt: Type.String(),
});

// External (linked / BIP-322) wallet challenge + mint. Mirrors the
// Turnkey pair above but the proof-of-control is a BIP-322 signature
// over the challenge message, bound to a `linked_wallets` row the user
// already proved control of via the wallet-linking flow.
const ExternalChallengeBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  walletProvider: Type.String({ minLength: 1 }),
  address: Type.String({ minLength: 1 }),
});

const ExternalChallengeResponse = Type.Object({
  challengeId: Type.String(),
  message: Type.String(),
  expiresAt: Type.String(),
});

const ExternalMintBody = Type.Object({
  // `auth_challenges.id` is a Postgres uuid column. Constrain the input to
  // a UUID so a malformed id is rejected with a clean 400 by the schema
  // validator instead of reaching the DB and surfacing as a 22P02 500.
  challengeId: Type.String({ format: "uuid" }),
  // BIP-322 signatures are conventionally base64 (witness blob); accept
  // whatever the wallet returns and let the Verifier decide.
  signature: Type.String({ minLength: 1 }),
});

const RevokeResponse = Type.Object({
  revoked: Type.Boolean(),
});

/**
 * Rows imported before migration 018 hold a caller-supplied key. Confirm
 * it against Turnkey once and remember the result; anything Turnkey
 * doesn't know (or a parent-org row) stays untrusted.
 */
async function verifyStoredResourceKey(
  server: FastifyInstance,
  request: FastifyRequest,
  resource: TurnkeyResourceRow,
): Promise<boolean> {
  if (!resource.default_address || !resource.default_public_key_hex) return false;
  if (resource.organization_id === server.config.TURNKEY_ORGANIZATION_ID) return false;
  try {
    const found = await findTurnkeyWalletAccount(getTurnkeyClient(), {
      organizationId: resource.organization_id,
      address: resource.default_address,
      publicKeyHex: resource.default_public_key_hex,
    });
    if (!found) return false;
    await withDbTransaction(getDbPool(), (client) =>
      markTurnkeyResourceKeyVerifiedForApp(client, {
        id: resource.id,
        appId: resource.app_id,
        walletId: found.walletId,
      }),
    );
    return true;
  } catch (err: any) {
    request.log.warn(
      { resourceId: resource.id, err: String(err?.message ?? err) },
      "auth.session.challenge.key_verification_failed",
    );
    return false;
  }
}

export const registerAuthSessionRoutes: FastifyPluginAsync = async (server) => {
  setDefaultRateLimitGroup(server, "auth");

  server.post(
    "/auth/session/challenge",
    {
      schema: {
        summary: "Mint a per-user proof-of-control challenge",
        tags: ["auth-sessions"],
        body: ChallengeBody,
        response: { 200: ChallengeResponse },
      },
    },
    async (request, reply) => {
      const appId = request.app!.appId;
      const body = request.body as typeof ChallengeBody.static;

      // Ensure the user exists. This is the same upsert the rest of
      // the API uses; the proof-of-control comes from the Turnkey
      // signature on the challenge, not from this lookup.
      const db = getDbPool();
      const lookup = await withDbTransaction(db, async (client) => {
        const user = await getOrCreateUserByExternalId(client, {
          appId,
          externalUserId: body.externalUserId,
        });
        const resource = await getTurnkeyResourceByIdForApp(client, {
          id: body.turnkeyResourceId,
          appId,
        });
        if (!resource) return null;
        if (resource.user_id !== user.id) return null;
        if (!resource.default_public_key_hex) return null;
        return { user, resource };
      });
      const keyTrusted =
        !!lookup &&
        (!!lookup.resource.key_verified_at ||
          (await verifyStoredResourceKey(server, request, lookup.resource)));
      const challenge =
        lookup && keyTrusted
          ? await withDbTransaction(db, (client) =>
              createChallenge(client, {
                appId,
                userId: lookup.user.id,
                externalUserId: body.externalUserId,
                resourceId: lookup.resource.id,
              }),
            )
          : null;

      if (!challenge) {
        return reply.code(400).send({
          statusCode: 400,
          error: "InvalidResource",
          message:
            "Turnkey resource not found for this user, or resource has no Turnkey-verified public key on file.",
        });
      }

      return challenge;
    },
  );

  server.post(
    "/auth/session",
    {
      schema: {
        summary: "Mint a session token by signing a previously-issued challenge",
        tags: ["auth-sessions"],
        body: MintBody,
        response: { 200: MintResponse },
      },
    },
    async (request, reply) => {
      const appId = request.app!.appId;
      const body = request.body as typeof MintBody.static;

      const result = await withDbTransaction(getDbPool(), async (client) => {
        const challenge = await loadConsumableChallenge(client, {
          challengeId: body.challengeId,
          appId,
        });
        // External challenges and pre-018 challenges carry no resource.
        if (!challenge || !challenge.resource_id) return { kind: "challenge_not_found" as const };

        const resource = await getTurnkeyResourceByIdForApp(client, {
          id: challenge.resource_id,
          appId,
        });
        if (
          !resource ||
          resource.user_id !== challenge.user_id ||
          !resource.key_verified_at ||
          !resource.default_public_key_hex
        ) {
          return { kind: "bad_signature" as const };
        }
        const verified = verifyChallengeSignature({
          payloadHex: challenge.payload_hex,
          signatureHex: body.signatureHex,
          defaultPublicKeyHex: resource.default_public_key_hex,
        });
        if (!verified) return { kind: "bad_signature" as const };

        const minted = await mintSession(client, {
          challengeId: challenge.id,
          appId,
          userId: challenge.user_id,
        });
        return { kind: "ok" as const, ...minted };
      });

      if (result.kind === "challenge_not_found") {
        return reply.code(400).send({
          statusCode: 400,
          error: "InvalidChallenge",
          message: "Challenge not found, already consumed, or expired.",
        });
      }
      if (result.kind === "bad_signature") {
        return reply.code(401).send({
          statusCode: 401,
          error: "InvalidSignature",
          message:
            "Challenge signature did not verify against the challenge's Turnkey resource.",
        });
      }
      return {
        sessionToken: result.token,
        expiresAt: result.expiresAt,
      };
    },
  );

  server.post(
    "/auth/session/external/challenge",
    {
      schema: {
        summary:
          "Mint a per-user proof-of-control challenge for an external (BIP-322) wallet",
        tags: ["auth-sessions"],
        body: ExternalChallengeBody,
        response: { 200: ExternalChallengeResponse },
      },
    },
    async (request, reply) => {
      const appId = request.app!.appId;
      const body = request.body as typeof ExternalChallengeBody.static;

      if (!Bip322Address.isValidBitcoinAddress(body.address)) {
        return reply.badRequest("Invalid bitcoin address");
      }
      if (!Bip322Address.isP2TR(body.address)) {
        return reply.badRequest("Only Taproot (p2tr) addresses are supported");
      }

      // Bind the challenge to a wallet the user has already linked
      // (proof-of-control was established at link time). The mint
      // re-checks this, but failing fast here gives a clean error.
      const challenge = await withDbTransaction(getDbPool(), async (client) => {
        const user = await getOrCreateUserByExternalId(client, {
          appId,
          externalUserId: body.externalUserId,
        });
        const linked = await getLinkedWalletForUser(client, {
          appId,
          userId: user.id,
          walletProvider: body.walletProvider,
          address: body.address,
        });
        if (!linked) return null;
        return createExternalChallenge(client, {
          appId,
          userId: user.id,
          externalUserId: body.externalUserId,
          walletProvider: body.walletProvider,
          address: body.address,
        });
      });

      if (!challenge) {
        return reply.code(400).send({
          statusCode: 400,
          error: "InvalidResource",
          message:
            "No linked wallet found for this user with the given provider and address. Link the wallet first.",
        });
      }

      return challenge;
    },
  );

  server.post(
    "/auth/session/external",
    {
      schema: {
        summary:
          "Mint a session token by BIP-322-signing an external-wallet challenge",
        tags: ["auth-sessions"],
        body: ExternalMintBody,
        response: { 200: MintResponse },
      },
    },
    async (request, reply) => {
      const appId = request.app!.appId;
      const body = request.body as typeof ExternalMintBody.static;

      const result = await withDbTransaction(getDbPool(), async (client) => {
        const challenge = await loadConsumableChallenge(client, {
          challengeId: body.challengeId,
          appId,
        });
        if (!challenge) return { kind: "challenge_not_found" as const };
        // Guard against using a Turnkey challenge on the external path.
        if (!challenge.address || !challenge.wallet_provider) {
          return { kind: "challenge_not_found" as const };
        }

        // Re-confirm the linked wallet still belongs to the challenge's
        // user before trusting a signature from its address.
        const linked = await getLinkedWalletForUser(client, {
          appId,
          userId: challenge.user_id,
          walletProvider: challenge.wallet_provider,
          address: challenge.address,
        });
        if (!linked) return { kind: "bad_signature" as const };

        const verified = verifyExternalChallengeSignature({
          address: challenge.address,
          message: challenge.message,
          signature: body.signature,
        });
        if (!verified) return { kind: "bad_signature" as const };

        const minted = await mintSession(client, {
          challengeId: challenge.id,
          appId,
          userId: challenge.user_id,
        });
        return { kind: "ok" as const, ...minted };
      });

      if (result.kind === "challenge_not_found") {
        return reply.code(400).send({
          statusCode: 400,
          error: "InvalidChallenge",
          message: "Challenge not found, already consumed, expired, or not an external challenge.",
        });
      }
      if (result.kind === "bad_signature") {
        return reply.code(401).send({
          statusCode: 401,
          error: "InvalidSignature",
          message:
            "BIP-322 signature did not verify against the linked wallet for this user.",
        });
      }
      return {
        sessionToken: result.token,
        expiresAt: result.expiresAt,
      };
    },
  );

  server.post(
    "/auth/session/revoke",
    {
      preHandler: server.requireSession,
      schema: {
        summary: "Revoke the current session token",
        tags: ["auth-sessions"],
        response: { 200: RevokeResponse },
      },
    },
    async (request) => {
      await withDbTransaction(getDbPool(), (client) =>
        revokeSession(client, {
          sessionId: request.session!.sessionId,
          appId: request.session!.appId,
        }),
      );
      return { revoked: true };
    },
  );
};
