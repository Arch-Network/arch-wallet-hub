import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";

/**
 * Per-key + per-IP rate limiting
 *
 * Defaults aim to be permissive for normal SDK use (a handful of
 * signing-request creations per minute per app) while making
 * credential-stuffing or recovery-OTP brute force unattractive. The
 * recovery + auth route plugins tighten this via `config.rateLimit`
 * (AUTH_ROUTE_RATE_LIMIT / RECOVERY_ROUTE_RATE_LIMIT below).
 *
 * Key derivation: `apiKeyId` + client IP. Every extension install shares
 * one app key, so an app-only bucket would let one client throttle all
 * users of that app. Unauthenticated requests fall back to the IP. Behind
 * ALB we honor `X-Forwarded-For` via the `trustProxy` option set in
 * `server.ts`.
 */
export function keyForRequest(req: FastifyRequest): string {
  const apiKeyId = req.app?.apiKeyId;
  if (apiKeyId) return `app:${apiKeyId}:ip:${req.ip}`;
  return `ip:${req.ip}`;
}

/** Session challenge/mint/revoke. Spread onto a route's `config`. */
export const AUTH_ROUTE_RATE_LIMIT = {
  rateLimit: {
    max: 20,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `auth:ip:${req.ip}`,
  },
};

/** Email recovery init/start/verify, on top of the per-email DB caps. */
export const RECOVERY_ROUTE_RATE_LIMIT = {
  rateLimit: {
    max: 10,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `recovery:ip:${req.ip}`,
  },
};

const rateLimitPlugin: FastifyPluginAsync = async (server) => {
  // Master switch. When disabled we skip registering @fastify/rate-limit
  // entirely; because route-level `config.rateLimit` overrides only take
  // effect when the global plugin is registered, this also makes every
  // per-route limit inert. Fully reversible via RATE_LIMIT_ENABLED=true.
  if (!server.config.RATE_LIMIT_ENABLED) {
    server.log.warn("Rate limiting is DISABLED (RATE_LIMIT_ENABLED=false)");
    return;
  }
  server.log.info("Rate limiting is enabled (300/min/key/ip global, per-route overrides apply)");

  await server.register(rateLimit, {
    global: true,
    max: 300, // requests per window per key + IP
    timeWindow: "1 minute",
    keyGenerator: keyForRequest,
    skipOnError: false,
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
    // Health & docs aren't worth counting. `@fastify/rate-limit` 9.x uses
    // `allowList`, not `skip` (the latter was silently ignored, so prior
    // to this rename health checks were actually counting against the
    // 300/min/key quota).
    allowList(req: FastifyRequest) {
      const url = req.url || "";
      if (url === "/v1/health" || url.startsWith("/v1/health/")) return true;
      if (url.startsWith("/v1/docs") || url.startsWith("/documentation")) return true;
      return false;
    },
    errorResponseBuilder(_req, ctx) {
      return {
        statusCode: 429,
        error: "TooManyRequests",
        message: `Rate limit exceeded, retry in ${ctx.after}`,
      };
    },
  });
};

export const registerRateLimit = fp(rateLimitPlugin, { name: "rate-limit" });
