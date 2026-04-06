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
  const isDev = server.config.NODE_ENV === "development";

  // In development, allow all origins to avoid CORS headaches.
  const allowed = isDev ? "*" : (envAllowed === "*" ? "*" : [...new Set([...(envAllowed as string[])])]);

  const allowHeaders = [
    "content-type",
    "x-api-key",
    "x-network",
    "idempotency-key",
    "authorization",
    "x-admin-api-key",
    "x-request-id"
  ].join(", ");

  const allowMethods = "GET,POST,PUT,PATCH,DELETE,OPTIONS";

  server.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;

    if (typeof origin === "string" && origin && isOriginAllowed(origin, allowed)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "origin");
      reply.header("access-control-allow-headers", allowHeaders);
      reply.header("access-control-allow-methods", allowMethods);
      reply.header("access-control-max-age", "600");
    }

    if (request.method === "OPTIONS") {
      // If no origin was matched but it's a preflight, still set wildcard in dev
      // so the browser doesn't block the subsequent actual request.
      if (isDev && !reply.getHeader("access-control-allow-origin")) {
        reply.header("access-control-allow-origin", origin || "*");
        reply.header("access-control-allow-headers", allowHeaders);
        reply.header("access-control-allow-methods", allowMethods);
        reply.header("access-control-max-age", "600");
      }
      reply.code(204).send();
      reply.hijack();
      return;
    }
  });
};

export const registerCors = fp(corsPlugin, { name: "cors" });
