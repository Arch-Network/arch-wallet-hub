import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { getDbPool } from "../db/pool.js";
import { withDbTransaction } from "../db/tx.js";
import { getTurnkeyResourceByIdForApp } from "../db/queries.js";
import { getUserByExternalId } from "../db/apps.js";
import { getTurnkeyClient } from "../turnkey/store.js";

const RegisterIndexedDbKeyBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  resourceId: Type.String({ minLength: 1 }),
  publicKey: Type.String({ minLength: 1 }), // compressed P-256 public key hex
  apiKeyName: Type.Optional(Type.String({ minLength: 1 })),
  expirationSeconds: Type.Optional(Type.String({ minLength: 1 }))
});

const RegisterIndexedDbKeyResponse = Type.Object({
  resourceId: Type.String(),
  organizationId: Type.String(),
  turnkeyUserId: Type.String(),
  apiKeyIds: Type.Array(Type.String()),
  activityId: Type.String()
});

export const registerTurnkeySessionRoutes: FastifyPluginAsync = async (server) => {
  server.post(
    "/turnkey/indexeddb-keys",
    {
      schema: {
        summary: "Register an IndexedDB session public key as an API key in the parent org (enables passkey read-write sessions for sub-orgs)",
        tags: ["turnkey"],
        body: RegisterIndexedDbKeyBody,
        response: { 200: RegisterIndexedDbKeyResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const body = request.body as any;
      const externalUserId = String(body.externalUserId);
      const resourceId = String(body.resourceId);
      const publicKey = String(body.publicKey);
      const apiKeyName = String(body.apiKeyName ?? `indexeddb-${publicKey.slice(0, 10)}`);
      const expirationSeconds = body.expirationSeconds ? String(body.expirationSeconds) : undefined;

      const db = getDbPool();
      const user = await withDbTransaction(db, (client) =>
        getUserByExternalId(client, { appId, externalUserId })
      );
      if (!user) return reply.notFound("Unknown externalUserId");

      const row = await withDbTransaction(db, (client) =>
        getTurnkeyResourceByIdForApp(client, { id: resourceId, appId })
      );
      if (!row) return reply.notFound("Unknown resourceId");
      if (row.user_id !== user.id) return reply.forbidden("Resource does not belong to user");

      const turnkey = getTurnkeyClient();
      // Important:
      // We must register the IndexedDB public key in the *parent* org (the org that owns the backend API key),
      // not the sub-org. Turnkey resolves keys from an org or its parent; registering in the parent avoids
      // "organization mismatch" errors when the backend API key is a parent-org voter.
      const whoami: any = await turnkey.ping();
      const parentOrgUserId = String(whoami?.userId ?? "");
      if (!parentOrgUserId) return reply.internalServerError("Turnkey whoami missing userId");

      const orgId = server.config.TURNKEY_ORGANIZATION_ID;
      const created = await turnkey.createApiKeyForUser({
        organizationId: orgId,
        userId: parentOrgUserId,
        apiKeyName,
        publicKey,
        curveType: "API_KEY_CURVE_P256",
        expirationSeconds
      });

      return {
        resourceId,
        organizationId: orgId,
        turnkeyUserId: parentOrgUserId,
        apiKeyIds: created.apiKeyIds,
        activityId: created.activityId
      };
    }
  );
};
