import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

/**
 * Reject non-HTTPS requests when REQUIRE_HTTPS is enabled.
 *
 * `trustProxy` is on (see server.ts), so `request.protocol` reflects
 * the `X-Forwarded-Proto` header set by the ALB / nginx terminating
 * TLS. When the flag is off the hook isn't installed at all, so there
 * is zero overhead and zero behavior change for dev / not-yet-TLS
 * deployments.
 *
 * Health checks are exempted: load balancers probe `/v1/health` over
 * plain HTTP internally, and failing those would flap the service.
 */
const requireHttpsPlugin: FastifyPluginAsync = async (server) => {
  if (!server.config.REQUIRE_HTTPS) return;

  server.addHook("onRequest", async (request, reply) => {
    if (request.protocol === "https") return;
    if (request.url === "/v1/health" || request.url.startsWith("/v1/health/")) {
      return;
    }
    return reply.code(426).send({
      statusCode: 426,
      error: "Upgrade Required",
      message: "HTTPS is required",
    });
  });
};

export const registerRequireHttps = fp(requireHttpsPlugin, {
  name: "require-https",
});
