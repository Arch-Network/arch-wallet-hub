import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import { getDbPool } from "../db/pool.js";
import { withDbTransaction } from "../db/tx.js";
import { createApp, insertAppApiKey } from "../db/apps.js";
import { generateApiKey } from "../platform/apiKeys.js";

/**
 * Constant-time string comparison. `crypto.timingSafeEqual` requires
 * equal-length inputs, so we normalize lengths and *always* run the
 * comparison (over the longer length) to keep timing independent of
 * the provided key's length. Returns false when either input is empty.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  const aBuf = Buffer.alloc(len);
  const bBuf = Buffer.alloc(len);
  aBuf.write(a);
  bBuf.write(b);
  const eq = crypto.timingSafeEqual(aBuf, bBuf);
  return eq && a.length === b.length;
}

function requireAdmin(server: any, request: any, reply: any) {
  const expected = server.config.PLATFORM_ADMIN_API_KEY as string | undefined;
  if (!expected) {
    // Hard-fail in production: an un-configured admin key effectively
    // disables app/key creation, which is OK, but we want to surface
    // it as a misconfiguration rather than a 501 that ops might miss.
    if (server.config.NODE_ENV === "production") {
      request.log.error("PLATFORM_ADMIN_API_KEY is required in production");
      return reply.serviceUnavailable("Admin API disabled");
    }
    return reply.notImplemented("PLATFORM_ADMIN_API_KEY not configured");
  }

  const auth = request.headers["authorization"];
  const x = request.headers["x-admin-api-key"];
  const provided =
    (typeof x === "string" && x.trim()) ||
    (typeof auth === "string" && auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()) ||
    "";

  if (!timingSafeEqualStrings(provided, expected)) {
    return reply.unauthorized("Invalid admin API key");
  }
}

const CreateAppBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  initialKeyName: Type.Optional(Type.String({ minLength: 1 }))
});

const CreateAppResponse = Type.Object({
  appId: Type.String(),
  name: Type.String(),
  apiKeyId: Type.String(),
  apiKey: Type.String()
});

export const registerPlatformRoutes: FastifyPluginAsync = async (server) => {
  server.post(
    "/platform/apps",
    {
      schema: {
        summary: "Create an app and issue an initial API key (admin only)",
        tags: ["platform"],
        body: CreateAppBody,
        response: { 200: CreateAppResponse }
      }
    },
    async (request, reply) => {
      const denied = requireAdmin(server, request, reply);
      if (denied) return denied;

      const db = getDbPool();
      const body = request.body as any;
      const keyName = body.initialKeyName ?? "default";

      const created = await withDbTransaction(db, async (client) => {
        const app = await createApp(client, { name: body.name });
        const gen = generateApiKey();
        const apiKeyRow = await insertAppApiKey(client, {
          appId: app.id,
          name: keyName,
          keyHash: gen.keyHash,
          keyPrefix: gen.keyPrefix
        });
        return { app, apiKeyRow, plaintext: gen.apiKey };
      });

      return {
        appId: created.app.id,
        name: created.app.name,
        apiKeyId: created.apiKeyRow.id,
        apiKey: created.plaintext
      };
    }
  );
};
