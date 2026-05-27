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

import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { withDbTransaction } from "../db/tx.js";
import { getOrCreateUserByExternalId } from "../db/apps.js";
import { getTurnkeyResourceByIdForApp } from "../db/queries.js";
import {
  createChallenge,
  loadConsumableChallenge,
  mintSession,
  revokeSession,
  verifyChallengeSignature,
} from "../auth/sessionToken.js";

const ChallengeBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  turnkeyResourceId: Type.String({ minLength: 1 }),
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

const RevokeResponse = Type.Object({
  revoked: Type.Boolean(),
});

export const registerAuthSessionRoutes: FastifyPluginAsync = async (server) => {
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
      const challenge = await withDbTransaction(server.db, async (client) => {
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
        return createChallenge(client, {
          appId,
          userId: user.id,
          externalUserId: body.externalUserId,
          resourceId: resource.id,
        });
      });

      if (!challenge) {
        return reply.code(400).send({
          statusCode: 400,
          error: "InvalidResource",
          message:
            "Turnkey resource not found for this user, or resource has no default public key on file.",
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

      const result = await withDbTransaction(server.db, async (client) => {
        const challenge = await loadConsumableChallenge(client, {
          challengeId: body.challengeId,
          appId,
        });
        if (!challenge) return { kind: "challenge_not_found" as const };

        // Look up the user's most-recent matching resource by
        // cross-referencing the challenge's user_id with their
        // turnkey_resources. We persisted resource_id implicitly via
        // the challenge message; re-derive it from the user's
        // resources here to keep the schema lean.
        const resourceRes = await client.query<{
          default_public_key_hex: string | null;
        }>(
          `
            SELECT default_public_key_hex
            FROM turnkey_resources
            WHERE app_id = $1 AND user_id = $2
              AND default_public_key_hex IS NOT NULL
            ORDER BY created_at DESC
          `,
          [appId, challenge.user_id],
        );

        // Try every candidate key. In the common case a user has one
        // Turnkey resource; trying all defends against the edge case
        // where a user has multiple resources and we don't know
        // which one signed.
        const candidates = resourceRes.rows
          .map((r) => r.default_public_key_hex)
          .filter((k): k is string => !!k);
        const verified = candidates.some((pubkey) =>
          verifyChallengeSignature({
            payloadHex: challenge.payload_hex,
            signatureHex: body.signatureHex,
            defaultPublicKeyHex: pubkey,
          }),
        );
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
            "Challenge signature did not verify against any Turnkey resource for this user.",
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
      await withDbTransaction(server.db, (client) =>
        revokeSession(client, {
          sessionId: request.session!.sessionId,
          appId: request.session!.appId,
        }),
      );
      return { revoked: true };
    },
  );
};
