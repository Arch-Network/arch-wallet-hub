import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { Type } from "@sinclair/typebox";
import { getDbPool } from "../db/pool.js";
import { withDbTransaction } from "../db/tx.js";
import { normalizePushAddresses, type PushAddress } from "../push/addresses.js";
import {
  EntitlementConfigurationError,
  EntitlementUpstreamError,
  isPushEntitled,
} from "../push/entitlement.js";
import { hasValidServiceKey } from "../push/serviceAuth.js";
import {
  CrossAppTokenConflict,
  deleteDeviceRegistration,
  lookupPushTargets,
  pruneInvalidTokens,
  replaceDeviceRegistration,
  type PushTargetLookup,
} from "../push/store.js";

const FcmToken = Type.String({ minLength: 1, maxLength: 4096 });
const Chain = Type.Union([Type.Literal("arch"), Type.Literal("btc")]);
const Platform = Type.Union([Type.Literal("ios"), Type.Literal("android")]);
const Address = Type.Object({
  chain: Chain,
  address: Type.String({ minLength: 1, maxLength: 128 }),
});
const OkResponse = Type.Object({ ok: Type.Literal(true) });

const RegisterBody = Type.Object({
  fcmToken: FcmToken,
  platform: Platform,
  addresses: Type.Array(Address, { maxItems: 200 }),
});
const DeleteBody = Type.Object({ fcmToken: FcmToken });

const TargetLookupBody = Type.Object({
  lookups: Type.Array(
    Type.Object({
      chain: Chain,
      address: Type.String({ minLength: 1, maxLength: 128 }),
      observedAt: Type.String({ format: "date-time" }),
    }),
    { minItems: 1, maxItems: 1000 },
  ),
});
const PruneBody = Type.Object({
  fcmTokens: Type.Array(FcmToken, { maxItems: 1000 }),
});

function normalizeToken(value: string): string {
  return value.trim();
}

function validateAddresses(addresses: PushAddress[]): PushAddress[] {
  return normalizePushAddresses(addresses);
}

export const registerPushRoutes: FastifyPluginAsync = async (server) => {
  const requireServiceAuth: preHandlerHookHandler = async (request, reply) => {
    if (!server.config.INDEXER_SERVICE_KEY) {
      return reply.serviceUnavailable("Push service authentication is not configured");
    }
    if (
      !hasValidServiceKey(
        request.headers as Record<string, unknown>,
        server.config.INDEXER_SERVICE_KEY,
      )
    ) {
      return reply.unauthorized("Invalid service key");
    }
  };

  server.post(
    "/push/register",
    {
      preHandler: server.requireSession,
      schema: {
        summary: "Register a device for receive push notifications",
        tags: ["push"],
        body: RegisterBody,
        response: { 200: OkResponse },
      },
    },
    async (request, reply) => {
      const body = request.body as typeof RegisterBody.static;
      const fcmToken = normalizeToken(body.fcmToken);
      if (!fcmToken) return reply.badRequest("fcmToken must not be blank");

      let addresses: PushAddress[];
      try {
        addresses = validateAddresses(body.addresses);
      } catch (error) {
        return reply.badRequest(
          error instanceof Error ? error.message : "Invalid address",
        );
      }

      try {
        if (!(await isPushEntitled(server.config, request.session!.appId))) {
          return reply.forbidden("Push API is not enabled for this app");
        }
      } catch (error) {
        if (error instanceof EntitlementConfigurationError) {
          return reply.serviceUnavailable(error.message);
        }
        if (error instanceof EntitlementUpstreamError) {
          request.log.error({ err: error.message }, "push entitlement check failed");
          return reply.badGateway("Push entitlement check failed");
        }
        throw error;
      }

      try {
        await withDbTransaction(getDbPool(), (client) =>
          replaceDeviceRegistration(client, {
            appId: request.session!.appId,
            userId: request.session!.userId,
            fcmToken,
            platform: body.platform,
            addresses,
          }),
        );
      } catch (error) {
        if (error instanceof CrossAppTokenConflict) {
          return reply.conflict(error.message);
        }
        throw error;
      }
      return { ok: true as const };
    },
  );

  server.delete(
    "/push/register",
    {
      preHandler: server.requireSession,
      schema: {
        summary: "Delete a device push registration",
        tags: ["push"],
        body: DeleteBody,
        response: { 200: OkResponse },
      },
    },
    async (request, reply) => {
      const body = request.body as typeof DeleteBody.static;
      const fcmToken = normalizeToken(body.fcmToken);
      if (!fcmToken) return reply.badRequest("fcmToken must not be blank");

      await withDbTransaction(getDbPool(), (client) =>
        deleteDeviceRegistration(client, {
          appId: request.session!.appId,
          userId: request.session!.userId,
          fcmToken,
        }),
      );
      return { ok: true as const };
    },
  );

  server.post(
    "/internal/push/targets",
    {
      preHandler: requireServiceAuth,
      schema: {
        summary: "Resolve push targets for observed address events",
        tags: ["internal-push"],
        body: TargetLookupBody,
      },
    },
    async (request, reply) => {
      const body = request.body as typeof TargetLookupBody.static;
      let lookups: PushTargetLookup[];
      try {
        lookups = body.lookups.map((lookup) => ({
          ...validateAddresses([
            { chain: lookup.chain, address: lookup.address },
          ])[0]!,
          observedAt: lookup.observedAt,
        }));
      } catch (error) {
        return reply.badRequest(
          error instanceof Error ? error.message : "Invalid address",
        );
      }

      const results = await withDbTransaction(getDbPool(), (client) =>
        lookupPushTargets(client, lookups),
      );
      return { results };
    },
  );

  server.post(
    "/internal/push/prune",
    {
      preHandler: requireServiceAuth,
      schema: {
        summary: "Prune invalid FCM registration tokens",
        tags: ["internal-push"],
        body: PruneBody,
      },
    },
    async (request, reply) => {
      const body = request.body as typeof PruneBody.static;
      const tokens = [...new Set(body.fcmTokens.map(normalizeToken))];
      if (tokens.some((token) => !token)) {
        return reply.badRequest("fcmTokens must not contain blank values");
      }
      const pruned = await withDbTransaction(getDbPool(), (client) =>
        pruneInvalidTokens(client, tokens),
      );
      return { ok: true as const, pruned };
    },
  );
};
