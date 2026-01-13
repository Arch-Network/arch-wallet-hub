import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

function parseAllowedOrigins(raw: string | undefined): string[] | "*" {
  if (!raw) return [];
  const v = raw.trim();
  if (!v) return [];
  if (v === "*") return "*";
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin: string, allowed: string[] | "*"): boolean {
  if (allowed === "*") return true;
  return allowed.includes(origin);
}

const corsPlugin: FastifyPluginAsync = async (server) => {
  const envAllowed = parseAllowedOrigins((server.config as any).CORS_ALLOW_ORIGINS);
  const defaults =
    server.config.NODE_ENV === "development"
      ? ["http://localhost:5173", "http://127.0.0.1:5173"]
      : [];
  const allowed = envAllowed === "*" ? "*" : [...new Set([...defaults, ...(envAllowed as string[])])];

  const allowHeaders = [
    "content-type",
    "x-api-key",
    "idempotency-key",
    "authorization",
    "x-admin-api-key",
    "x-request-id"
  ].join(", ");

  const allowMethods = "GET,POST,PUT,PATCH,DELETE,OPTIONS";

  server.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && origin) {
      if (isOriginAllowed(origin, allowed)) {
        reply.header("access-control-allow-origin", origin);
        reply.header("vary", "origin");
        reply.header("access-control-allow-headers", allowHeaders);
        reply.header("access-control-allow-methods", allowMethods);
        reply.header("access-control-max-age", "600");
      }
    }

    // Always short-circuit preflight BEFORE auth hooks.
    if (request.method === "OPTIONS") {
      reply.code(204).send();
      // Ensure Fastify stops processing additional hooks (like auth).
      reply.hijack();
      return;
    }
  });
};

// Disable encapsulation so the onRequest hook applies to all routes registered after this plugin.
export const registerCors = fp(corsPlugin, { name: "cors" });
