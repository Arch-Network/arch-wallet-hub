import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

export const REQUEST_ID_HEADER = "x-request-id";

// A caller's id is written to the logs and the audit rows and sent back
// as a response header, so it is taken only when it is a plain token.
const CALLER_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The id a request is logged under: the caller's `x-request-id` when it
 * is a plain token, else a fresh UUID. Use as Fastify's `genReqId` with
 * `requestIdHeader: false`, which otherwise takes the header as sent.
 */
export function genRequestId(req: Pick<IncomingMessage, "headers">): string {
  const given = req.headers[REQUEST_ID_HEADER];
  return typeof given === "string" && CALLER_REQUEST_ID.test(given) ? given : crypto.randomUUID();
}

const observabilityPlugin: FastifyPluginAsync = async (server) => {
  // Every response names its request, so a client can report the id and
  // the matching `request.completed` line can be found. onSend covers
  // replies sent from hooks too (auth 401s, rate-limit 429s).
  server.addHook("onSend", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  server.addHook("onResponse", async (request, reply) => {
    // Fastify already logs requests; this hook adds a stable structured summary
    // that is easy to aggregate (and ensures requestId is always included).
    // The API error alarms in infra/cdk/lib/api-error-alarms.ts count
    // these lines by `msg` and `statusCode`; renaming either silences them.
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
