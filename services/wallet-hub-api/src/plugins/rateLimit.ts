import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";

/**
 * Per-key + per-IP rate limiting
 *
 * Defaults aim to be permissive for normal SDK use (a handful of
 * signing-request creations per minute per app) while making
 * credential-stuffing or recovery-OTP brute force unattractive. The
 * recovery + auth endpoints are tightened further inside their own
 * route handlers via `config.rateLimit`.
 *
 * Key derivation: prefer the authenticated `apiKeyId` (so a single
 * compromised API key can't drown out everyone else on the shared IP
 * of a serverless platform); fall back to the request IP. Behind ALB
 * we honor `X-Forwarded-For` via the `trustProxy` option set in
 * `server.ts`.
 */
function keyForRequest(req: FastifyRequest): string {
  const apiKeyId = req.app?.apiKeyId;
  if (apiKeyId) return `app:${apiKeyId}`;
  return `ip:${req.ip}`;
}

const rateLimitPlugin: FastifyPluginAsync = async (server) => {
  await server.register(rateLimit, {
    global: true,
    max: 300, // requests per window per key
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
