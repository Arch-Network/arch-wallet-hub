import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const observabilityPlugin: FastifyPluginAsync = async (server) => {
  server.addHook("onResponse", async (request, reply) => {
    // Fastify already logs requests; this hook adds a stable structured summary
    // that is easy to aggregate (and ensures requestId is always included).
    request.log.info(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTimeMs: reply.getResponseTime()
      },
      "request.completed"
    );
  });
};

// MUST be fp-wrapped: a bare async plugin runs in its own encapsulated scope,
// so the onResponse hook would only fire for routes registered inside this
// plugin (none) — never for sibling route plugins. fp hoists the hook to the
// root instance so it fires for ALL routes. (Same encapsulation bug as the
// pre-fix registerDb; see authSessionsDbAccess regression test.)
export const registerObservability = fp(observabilityPlugin, {
  name: "observability",
});

