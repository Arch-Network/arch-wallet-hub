import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import cors from "@fastify/cors";

/**
 * CORS policy
 *
 * Strict by default. The bespoke implementation we used to ship had two
 * footguns: it reflected any Origin in dev (allowing credentialed
 * cross-origin requests from random localhosts), and it would reflect
 * with `*` when `CORS_ALLOW_ORIGINS=*` was set in env, which combined
 * with our credentialed headers (`x-api-key`, `authorization`) would
 * let any site spend a victim's API key. We now delegate to
 * `@fastify/cors` and:
 *
 *   - Build an explicit allow-list from `CORS_ALLOW_ORIGINS`
 *     (comma-separated).
 *   - In `development`, augment that list with the standard local dev
 *     origins (Vite, CRA, mobile bundler). We do NOT use `*`.
 *   - In `production`, refuse to start CORS if the allow-list is empty
 *     or contains `*`. Operators must enumerate origins.
 *   - Set `credentials: false`. The API authenticates with an
 *     application API key in `X-API-Key`, not cookies; sites that
 *     embed the SDK should also not need cookie passthrough.
 */

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const DEV_ORIGIN_ALLOWLIST = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
];

const ALLOW_HEADERS = [
  "content-type",
  "x-api-key",
  "x-network",
  "idempotency-key",
  "authorization",
  "x-admin-api-key",
  "x-request-id",
];

const ALLOW_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const corsPlugin: FastifyPluginAsync = async (server) => {
  const isDev = server.config.NODE_ENV === "development";
  const isProd = server.config.NODE_ENV === "production";
  const configured = parseAllowedOrigins(
    (server.config as any).CORS_ALLOW_ORIGINS,
  );

  if (isProd) {
    if (configured.length === 0) {
      throw new Error(
        "CORS_ALLOW_ORIGINS must be set to an explicit comma-separated list in production",
      );
    }
    if (configured.includes("*")) {
      throw new Error(
        "CORS_ALLOW_ORIGINS=* is not permitted in production (it would let any site spend a user's API key)",
      );
    }
  }

  const allowed = new Set(isDev ? [...configured, ...DEV_ORIGIN_ALLOWLIST] : configured);

  await server.register(cors, {
    // Function form gives us per-request decisions without ever
    // reflecting an arbitrary Origin into the response.
    origin(origin, cb) {
      if (!origin) {
        // Non-browser callers (curl, server-to-server) send no Origin.
        // We don't need to set CORS headers for them.
        return cb(null, false);
      }
      if (allowed.has(origin)) return cb(null, true);
      // Explicitly DENY: returning false (not throwing) lets Fastify
      // respond cleanly while still omitting Access-Control-Allow-Origin.
      cb(null, false);
    },
    methods: ALLOW_METHODS,
    allowedHeaders: ALLOW_HEADERS,
    credentials: false,
    maxAge: 600,
    strictPreflight: true,
  });
};

export const registerCors = fp(corsPlugin, { name: "cors" });
