import type { FastifyPluginAsync } from "fastify";

export const registerObservability: FastifyPluginAsync = async (server) => {
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

