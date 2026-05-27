/**
 * Route-level session-token enforcement.
 *
 * Adds two helpers to the Fastify instance:
 *
 *   server.requireSession  : preHandler factory for routes that
 *                            need a valid per-user bearer.
 *   request.session        : populated by the preHandler; bound to
 *                            {sessionId, appId, userId,
 *                            externalUserId}.
 *
 * Why route-level (not global): rolling enforcement out incrementally
 * is safer on mainnet. Routes that haven't been migrated yet keep
 * trusting `body.externalUserId` as before; routes that opt in get
 * the new binding. The migration plan is one-route-per-PR.
 */

import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import fp from "fastify-plugin";
import { getDbPool } from "../db/pool.js";
import { withDbTransaction } from "../db/tx.js";
import {
  resolveSessionToken,
  SESSION_TOKEN_PREFIX,
  type SessionPrincipal,
} from "../auth/sessionToken.js";

declare module "fastify" {
  interface FastifyRequest {
    session?: SessionPrincipal;
  }
  interface FastifyInstance {
    requireSession: preHandlerHookHandler;
  }
}

function extractSessionBearer(authHeader: unknown): string | null {
  if (typeof authHeader !== "string") return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m?.[1]) return null;
  const token = m[1].trim();
  return token.startsWith(SESSION_TOKEN_PREFIX) ? token : null;
}

const requireSessionPreHandler: preHandlerHookHandler = async function (request, reply) {
  // appAuth ran first and populated request.app. If we got here
  // without it, the per-app pre-check above us is misconfigured.
  if (!request.app?.appId) {
    return reply.unauthorized("Missing app authentication");
  }
  const bearer = extractSessionBearer(request.headers["authorization"]);
  if (!bearer) {
    return reply.unauthorized("Missing or malformed session bearer");
  }
  const db = getDbPool();
  const principal = await withDbTransaction(db, (client) =>
    resolveSessionToken(client, { token: bearer, appId: request.app!.appId }),
  );
  if (!principal) {
    return reply.unauthorized("Invalid or expired session token");
  }
  request.session = principal;
};

const sessionAuthPlugin: FastifyPluginAsync = async (server) => {
  server.decorate("requireSession", requireSessionPreHandler);
};

export const registerSessionAuth = fp(sessionAuthPlugin, { name: "session-auth" });
