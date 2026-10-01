import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";

/**
 * Per-key + per-IP rate limiting
 *
 * Defaults aim to be permissive for normal SDK use (a handful of
 * signing-request creations per minute per app) while making
 * credential-stuffing or recovery-OTP brute force unattractive.
 *
 * Every route counts against exactly one group in RATE_LIMITS, named by
 * its `config.rateLimitGroup` (default `global`). Route plugins set the
 * group for their whole scope with `setDefaultRateLimitGroup`; a route
 * can name its own in `config`.
 *
 * Key derivation: `apiKeyId` + client IP. Every extension install shares
 * one app key, so an app-only bucket would let one client throttle all
 * users of that app. Indexer and send routes key by `x-arch-install-id`
 * instead when the client sends a well-formed one. Unauthenticated
 * requests fall back to the IP. Behind ALB we honor `X-Forwarded-For`
 * via the `trustProxy` option set in `server.ts`.
 */

export type RateLimitGroup = "global" | "auth" | "recovery" | "indexer" | "send";

declare module "fastify" {
  interface FastifyContextConfig {
    rateLimitGroup?: RateLimitGroup;
  }
}

export function keyForRequest(req: FastifyRequest): string {
  const apiKeyId = req.app?.apiKeyId;
  if (apiKeyId) return `app:${apiKeyId}:ip:${req.ip}`;
  return `ip:${req.ip}`;
}

const INSTALL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** The client's `x-arch-install-id`, or null when absent or malformed. */
export function installIdFor(req: FastifyRequest): string | null {
  const raw = req.headers["x-arch-install-id"];
  return typeof raw === "string" && INSTALL_ID_RE.test(raw) ? raw : null;
}

/** App key + install id when the request carries both, else `keyForRequest`. */
export function installKeyForRequest(req: FastifyRequest): string {
  const apiKeyId = req.app?.apiKeyId;
  const installId = installIdFor(req);
  if (apiKeyId && installId) return `app:${apiKeyId}:install:${installId}`;
  return keyForRequest(req);
}

const routeIpKey = (req: FastifyRequest) => `route:${req.routeOptions.url}:ip:${req.ip}`;

type GroupLimit = {
  max: number;
  keyGenerator: (req: FastifyRequest) => string;
  ipCeiling?: number;
};

/**
 * Requests per minute. `max` is enforced by @fastify/rate-limit per
 * `keyGenerator` key. `ipCeiling` is a second, per-IP limit for groups
 * keyed by install id: the id is client-chosen, so rotating it must not
 * buy unlimited throughput from one address.
 */
export const RATE_LIMITS: Record<RateLimitGroup, GroupLimit> = {
  global: { max: 300, keyGenerator: keyForRequest },
  // Session challenge/mint/revoke.
  auth: { max: 20, keyGenerator: routeIpKey },
  // Email recovery init/start/verify, on top of the per-email DB caps.
  recovery: { max: 10, keyGenerator: routeIpKey },
  indexer: { max: 600, keyGenerator: installKeyForRequest, ipCeiling: 3000 },
  // Broadcast, UTXOs, fee estimates, signing-request create/submit.
  send: { max: 120, keyGenerator: installKeyForRequest, ipCeiling: 600 },
};

const TIME_WINDOW = "1 minute";
const WINDOW_MS = 60_000;
const IP_CEILING_MAX_KEYS = 10_000;

function tooManyRequests(after: string) {
  return {
    statusCode: 429,
    error: "TooManyRequests",
    message: `Rate limit exceeded, retry in ${after}`,
  };
}

/** Keys carry install ids and client IPs; logs get a partial form. */
export function maskKey(key: string): string {
  return key
    .replace(/(app|install):([^:]{0,6})[^:]*/g, "$1:$2…")
    .replace(/(^|:)ip:(.+)$/, (_m, lead: string, ip: string) =>
      ip.includes(".")
        ? `${lead}ip:${ip.replace(/\.\d+$/, ".x")}`
        : `${lead}ip:${ip.split(":").slice(0, 3).join(":")}:…`,
    );
}

/** Count every route registered in `scope` against `group`, unless the route names its own. */
export function setDefaultRateLimitGroup(scope: FastifyInstance, group: RateLimitGroup): void {
  scope.addHook("onRoute", (routeOptions) => {
    routeOptions.config = { rateLimitGroup: group, ...routeOptions.config };
  });
}

type Exceeded = { rule: string; key: string; limit: number; count?: number; error: unknown };
type Check = (req: FastifyRequest, reply: FastifyReply) => Promise<Exceeded | null>;

function pluginCheck(server: FastifyInstance, group: RateLimitGroup): Check {
  const { max, keyGenerator } = RATE_LIMITS[group];
  const handler = server.rateLimit({ max, timeWindow: TIME_WINDOW, keyGenerator });
  return async (req, reply) => {
    try {
      await handler.call(server, req, reply);
      return null;
    } catch (error) {
      if ((error as { statusCode?: number } | undefined)?.statusCode !== 429) throw error;
      return { rule: group, key: keyGenerator(req), limit: max, error };
    }
  };
}

/** Fixed window per client IP, oldest windows evicted past IP_CEILING_MAX_KEYS. */
function ipCeilingCheck(group: RateLimitGroup, max: number): Check {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return async (req, reply) => {
    const now = Date.now();
    let window = windows.get(req.ip);
    if (!window || window.resetAt <= now) {
      windows.delete(req.ip);
      window = { count: 0, resetAt: now + WINDOW_MS };
      windows.set(req.ip, window);
      if (windows.size > IP_CEILING_MAX_KEYS) windows.delete(windows.keys().next().value!);
    }
    window.count += 1;
    if (window.count <= max) return null;
    const seconds = Math.ceil((window.resetAt - now) / 1000);
    reply
      .header("x-ratelimit-limit", max)
      .header("x-ratelimit-remaining", 0)
      .header("x-ratelimit-reset", seconds)
      .header("retry-after", seconds);
    return {
      rule: `${group}-ip`,
      key: `ip:${req.ip}`,
      limit: max,
      count: window.count,
      error: tooManyRequests(TIME_WINDOW),
    };
  };
}

const rateLimitPlugin: FastifyPluginAsync = async (server) => {
  // Master switch. When off we skip registering @fastify/rate-limit
  // entirely, which also makes every route's `rateLimitGroup` inert.
  const mode = server.config.RATE_LIMIT_ENABLED;
  if (mode === "off") {
    server.log.warn("Rate limiting is DISABLED (RATE_LIMIT_ENABLED=false)");
    return;
  }
  server.log.info({ mode }, "Rate limiting is enabled (per-group limits, see plugins/rateLimit.ts)");

  await server.register(rateLimit, {
    global: false,
    timeWindow: TIME_WINDOW,
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
    errorResponseBuilder: (_req, ctx) => tooManyRequests(ctx.after),
  });

  const checks = {} as Record<RateLimitGroup, Check[]>;
  for (const group of Object.keys(RATE_LIMITS) as RateLimitGroup[]) {
    const { ipCeiling } = RATE_LIMITS[group];
    checks[group] = [pluginCheck(server, group)];
    if (ipCeiling) checks[group].push(ipCeilingCheck(group, ipCeiling));
  }

  // Both modes stop at the first exceeded check, so log-only counts
  // exactly what enforcing would.
  async function limitRequest(request: FastifyRequest, reply: FastifyReply) {
    for (const check of checks[request.routeOptions.config.rateLimitGroup ?? "global"]) {
      const exceeded = await check(request, reply);
      if (!exceeded) continue;
      if (mode === "enforce") throw exceeded.error;
      reply.removeHeader("retry-after");
      request.log.warn(
        {
          rateLimit: {
            route: `${request.method} ${request.routeOptions.url}`,
            rule: exceeded.rule,
            key: maskKey(exceeded.key),
            limit: exceeded.limit,
            count: exceeded.count,
          },
        },
        "Rate limit exceeded (log-only, request allowed)",
      );
      return;
    }
  }

  // @fastify/rate-limit reads `config.rateLimit` in its own onRoute hook,
  // which runs before any route plugin's, so config injected from a child
  // scope is never seen. The group is therefore resolved per request.
  server.addHook("onRoute", (routeOptions) => {
    const own = routeOptions.onRequest;
    routeOptions.onRequest = own ? [...(Array.isArray(own) ? own : [own]), limitRequest] : [limitRequest];
  });
};

export const registerRateLimit = fp(rateLimitPlugin, { name: "rate-limit" });
