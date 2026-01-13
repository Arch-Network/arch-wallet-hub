import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { sha256Hex } from "../platform/apiKeys.js";
import { withDbTransaction } from "../db/tx.js";
import { getDbPool } from "../db/pool.js";
import { getAppApiKeyByHash, touchAppApiKeyLastUsed } from "../db/apps.js";

export type AppAuthContext = {
  appId: string;
  apiKeyId: string;
  apiKeyPrefix: string;
};

declare module "fastify" {
  interface FastifyRequest {
    app?: AppAuthContext;
  }
}

function extractApiKey(req: { headers: Record<string, unknown> }): string | null {
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) return xApiKey.trim();

  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function isPublicPath(url: string): boolean {
  // Allow health + OpenAPI docs without auth.
  if (url === "/v1/health") return true;
  if (url.startsWith("/v1/docs")) return true;
  if (url.startsWith("/v1/platform")) return true; // bootstrapped via admin key
  if (url.startsWith("/documentation")) return true; // swagger default
  if (url.startsWith("/v1/documentation")) return true;
  return false;
}

const appAuthPlugin: FastifyPluginAsync = async (server) => {
  server.addHook("onRequest", async (request, reply) => {
    if (isPublicPath(request.url)) return;

    const apiKey = extractApiKey({ headers: request.headers as any });
    if (!apiKey) return reply.unauthorized("Missing API key (send X-API-Key or Authorization: Bearer)");

    const db = getDbPool();
    const keyHash = sha256Hex(apiKey);

    const row = await withDbTransaction(db, async (client) => {
      const k = await getAppApiKeyByHash(client, { keyHash });
      if (k) await touchAppApiKeyLastUsed(client, { id: k.id });
      return k;
    });

    if (!row) return reply.unauthorized("Invalid API key");
    if (row.revoked_at) return reply.unauthorized("API key revoked");

    request.app = { appId: row.app_id, apiKeyId: row.id, apiKeyPrefix: row.key_prefix };
  });
};

// Disable encapsulation so the onRequest hook applies to all routes registered after this plugin.
export const registerAppAuth = fp(appAuthPlugin, { name: "app-auth" });
