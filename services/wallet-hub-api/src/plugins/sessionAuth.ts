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
import { userHasCredentials } from "../db/apps.js";
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
    /**
     * preHandler factory for Phase 2b: enforces a session + binds the
     * caller's externalUserId to the session principal, but ONLY when
     * `routeKey` is enabled via SESSION_ENFORCED_ROUTES. When the route
     * isn't enabled it's a zero-cost no-op, so wiring it onto a route is
     * safe to ship ahead of turning enforcement on.
     */
    enforceSessionForRoute: (routeKey: string) => preHandlerHookHandler;
    /**
     * preHandler for routes that attach a new credential (Turnkey
     * resource or linked wallet) to the claimed externalUserId. Always
     * on, independent of SESSION_ENFORCED_ROUTES.
     */
    requireSessionForExistingUser: preHandlerHookHandler;
  }
}

export interface EnforcedRouteConfig {
  /** Enforce every opted-in route ("*" / "all" in the env value). */
  all: boolean;
  set: Set<string>;
}

/**
 * Parse SESSION_ENFORCED_ROUTES (comma-separated route keys). Tolerant of
 * whitespace and empty entries. "*" or "all" (case-insensitive) flips the
 * `all` switch.
 */
export function parseEnforcedRoutes(csv: string | undefined): EnforcedRouteConfig {
  const set = new Set<string>();
  let all = false;
  for (const raw of (csv ?? "").split(",")) {
    const token = raw.trim();
    if (!token) continue;
    if (token === "*" || token.toLowerCase() === "all") {
      all = true;
      continue;
    }
    set.add(token);
  }
  return { all, set };
}

export function isRouteEnforced(config: EnforcedRouteConfig, routeKey: string): boolean {
  return config.all || config.set.has(routeKey);
}

export type SessionEnforcementDecision =
  | "skip"
  | "unauthorized"
  | "forbidden"
  | "allow";

/**
 * Pure decision for a route guarded by `enforceSessionForRoute`. Kept
 * free of Fastify types so the (security-critical) branching is unit
 * testable in isolation.
 *
 *   skip         -> route not enforced; behave exactly as before
 *   unauthorized -> enforced but no valid session token -> 401
 *   forbidden    -> session valid but the caller claimed a DIFFERENT
 *                   externalUserId than the session principal -> 403
 *   allow        -> enforced, session valid, principal matches (or the
 *                   route carries no externalUserId to bind)
 */
export function sessionEnforcementDecision(args: {
  enabled: boolean;
  hasValidSession: boolean;
  sessionExternalUserId?: string;
  claimedExternalUserId?: unknown;
}): SessionEnforcementDecision {
  if (!args.enabled) return "skip";
  if (!args.hasValidSession) return "unauthorized";
  const claimed = args.claimedExternalUserId;
  if (typeof claimed === "string" && claimed.length > 0) {
    if (claimed !== args.sessionExternalUserId) return "forbidden";
  }
  return "allow";
}

/**
 * Pure decision for `requireSessionForExistingUser`. A user with no
 * credential yet has nothing to take over and can't hold a session, so
 * onboarding passes; once a user owns a credential, attaching another
 * one requires a session for that same user.
 */
export function credentialAttachDecision(args: {
  userHasCredentials: boolean;
  hasValidSession: boolean;
  sessionExternalUserId?: string;
  claimedExternalUserId: string;
}): SessionEnforcementDecision {
  if (!args.userHasCredentials) return "skip";
  if (!args.hasValidSession) return "unauthorized";
  if (args.sessionExternalUserId !== args.claimedExternalUserId) return "forbidden";
  return "allow";
}

function extractSessionBearer(authHeader: unknown): string | null {
  if (typeof authHeader !== "string") return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m?.[1]) return null;
  const token = m[1].trim();
  return token.startsWith(SESSION_TOKEN_PREFIX) ? token : null;
}

/**
 * Validate the session bearer and populate `request.session`. On any
 * failure it sends the 401 reply and returns false; callers must stop.
 * Returns true when a valid session was attached.
 */
async function attachSessionOrReply(
  request: Parameters<preHandlerHookHandler>[0],
  reply: Parameters<preHandlerHookHandler>[1],
): Promise<boolean> {
  // appAuth ran first and populated request.app. If we got here
  // without it, the per-app pre-check above us is misconfigured.
  if (!request.app?.appId) {
    await reply.unauthorized("Missing app authentication");
    return false;
  }
  const bearer = extractSessionBearer(request.headers["authorization"]);
  if (!bearer) {
    await reply.unauthorized("Missing or malformed session bearer");
    return false;
  }
  const db = getDbPool();
  const principal = await withDbTransaction(db, (client) =>
    resolveSessionToken(client, { token: bearer, appId: request.app!.appId }),
  );
  if (!principal) {
    await reply.unauthorized("Invalid or expired session token");
    return false;
  }
  request.session = principal;
  return true;
}

const requireSessionPreHandler: preHandlerHookHandler = async function (request, reply) {
  await attachSessionOrReply(request, reply);
};

/** Best-effort read of a claimed externalUserId from body or query. */
function claimedExternalUserId(request: Parameters<preHandlerHookHandler>[0]): unknown {
  const body = request.body as { externalUserId?: unknown } | undefined;
  if (body && typeof body === "object" && "externalUserId" in body) {
    return body.externalUserId;
  }
  const query = request.query as { externalUserId?: unknown } | undefined;
  if (query && typeof query === "object" && "externalUserId" in query) {
    return query.externalUserId;
  }
  return undefined;
}

const sessionAuthPlugin: FastifyPluginAsync = async (server) => {
  server.decorate("requireSession", requireSessionPreHandler);

  // Parse the enforcement allowlist once at registration; server.config
  // is available by now (env plugin registers earlier).
  const enforced = parseEnforcedRoutes(server.config?.SESSION_ENFORCED_ROUTES);

  server.decorate("enforceSessionForRoute", (routeKey: string): preHandlerHookHandler => {
    return async function (request, reply) {
      const enabled = isRouteEnforced(enforced, routeKey);
      // Fast path: route not enforced -> behave exactly as before.
      if (!enabled) return;

      const ok = await attachSessionOrReply(request, reply);
      if (!ok) return; // reply already sent (401)

      const decision = sessionEnforcementDecision({
        enabled: true,
        hasValidSession: true,
        sessionExternalUserId: request.session?.externalUserId,
        claimedExternalUserId: claimedExternalUserId(request),
      });
      if (decision === "forbidden") {
        return reply.forbidden(
          "Body/query externalUserId does not match session principal",
        );
      }
    };
  });

  server.decorate("requireSessionForExistingUser", async function (request, reply) {
    if (reply.sent) return;
    const claimed = claimedExternalUserId(request);
    if (typeof claimed !== "string" || !claimed || !request.app?.appId) return;
    const appId = request.app.appId;
    const hasCredentials = await withDbTransaction(getDbPool(), (client) =>
      userHasCredentials(client, { appId, externalUserId: claimed }),
    );
    if (!hasCredentials) return;
    if (!request.session) {
      const ok = await attachSessionOrReply(request, reply);
      if (!ok) return;
    }
    const decision = credentialAttachDecision({
      userHasCredentials: true,
      hasValidSession: true,
      sessionExternalUserId: request.session?.externalUserId,
      claimedExternalUserId: claimed,
    });
    if (decision === "forbidden") {
      return reply.forbidden("Body/query externalUserId does not match session principal");
    }
  } as preHandlerHookHandler);
};

export const registerSessionAuth = fp(sessionAuthPlugin, { name: "session-auth" });
