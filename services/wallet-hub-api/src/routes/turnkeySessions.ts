import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { getDbPool } from "../db/pool.js";
import { withDbTransaction } from "../db/tx.js";
import { getTurnkeyResourceByIdForApp } from "../db/queries.js";
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
      // SECURITY: this route registers an arbitrary P-256 public key as
      // a signing API key on a user's Turnkey sub-org -- i.e. it grants
      // signing authority. With app-key auth alone, a holder of the
      // shared app API key could pass a victim's externalUserId +
      // resourceId and register their OWN key on the victim's sub-org
      // (the resource-ownership check below passes because both values
      // are attacker-supplied and internally consistent). Requiring a
      // per-user session token -- and binding the body to the session
      // principal -- closes that IDOR. No shipped client calls this
      // route, so enforcing a session here is non-breaking.
      preHandler: server.requireSession,
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
      const session = request.session;
      if (!session) return reply.unauthorized("Session required");

      const body = request.body as any;
      const externalUserId = String(body.externalUserId);
      if (externalUserId !== session.externalUserId) {
        return reply.forbidden("Body externalUserId does not match session principal");
      }
      const resourceId = String(body.resourceId);
      const publicKey = String(body.publicKey);
      const apiKeyName = String(body.apiKeyName ?? `indexeddb-${publicKey.slice(0, 10)}`);
      const expirationSeconds = body.expirationSeconds ? String(body.expirationSeconds) : undefined;

      // Identity comes from the authenticated session, not the body.
      const user = { id: session.userId };

      const db = getDbPool();
      const row = await withDbTransaction(db, (client) =>
        getTurnkeyResourceByIdForApp(client, { id: resourceId, appId })
      );
      if (!row) return reply.notFound("Unknown resourceId");
      if (row.user_id !== user.id) return reply.forbidden("Resource does not belong to user");

      const turnkey = getTurnkeyClient();
      // SECURITY: register the IndexedDB session public key in the
      // user's *sub-org* against the sub-org's root user, NOT in the
      // parent org. Earlier revisions registered against the parent
      // org's root user (via whoami), which meant a compromised
      // IndexedDB session key inherited parent-org signing authority
      // and could affect every wallet in the org.
      //
      // The required identifiers come from the stored
      // `turnkey_resources` row (`organization_id` and
      // `turnkey_root_user_id`), which were captured at sub-org
      // creation time and never re-read from Turnkey.
      const subOrgId = row.organization_id;
      const subOrgRootUserId = row.turnkey_root_user_id;
      if (!subOrgId || !subOrgRootUserId) {
        return reply.conflict(
          "Resource is missing sub-org user identifiers; cannot register IndexedDB key safely"
        );
      }

      const created = await turnkey.createApiKeyForUser({
        organizationId: subOrgId,
        userId: subOrgRootUserId,
        apiKeyName,
        publicKey,
        curveType: "API_KEY_CURVE_P256",
        expirationSeconds
      });

      return {
        resourceId,
        organizationId: subOrgId,
        turnkeyUserId: subOrgRootUserId,
        apiKeyIds: created.apiKeyIds,
        activityId: created.activityId
      };
    }
  );
};
