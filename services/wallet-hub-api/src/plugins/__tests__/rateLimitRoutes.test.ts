import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TRUST_PROXY_HOPS } from "../../server.js";
import { RATE_LIMITS, registerRateLimit } from "../rateLimit.js";
import { registerSessionAuth } from "../sessionAuth.js";
import { registerAuthSessionRoutes } from "../../routes/authSessions.js";
import { registerSigningRequestRoutes } from "../../routes/signingRequests.js";
import { registerRecoveryRoutes } from "../../routes/recovery.js";
import { registerIndexerRoutes } from "../../routes/indexer.js";

/**
 * Regression guard for per-route limits that never applied: the route
 * plugins set their limits from a child-scope `onRoute` hook, which runs
 * after @fastify/rate-limit's own root `onRoute` hook has already read
 * `config.rateLimit`. Everything silently shared the global 300/min
 * bucket.
 *
 * So this registers the REAL route plugins, in server.ts order, behind
 * the same trustProxy setting. Handlers never need the DB: allowed
 * requests stop at schema validation (400) or the missing indexer (501).
 */
const ALB = "172.31.40.10";
const CLIENT = "203.0.113.7";
const INSTALL_A = "11111111-1111-4111-8111-111111111111";
const INSTALL_B = "22222222-2222-4222-8222-222222222222";

async function buildServer(mode: "enforce" | "log", logs: any[] = []) {
  const app = Fastify({
    trustProxy: TRUST_PROXY_HOPS,
    logger: { level: "warn", stream: { write: (line: string) => logs.push(JSON.parse(line)) } },
  });
  app.decorate("config", {
    RATE_LIMIT_ENABLED: mode,
    SESSION_ENFORCED_ROUTES: "",
    TURNKEY_ORGANIZATION_ID: "root-org",
  } as never);
  // Stand-in for appAuth: every client shares one app key, like the extension.
  app.addHook("onRequest", async (request) => {
    (request as any).app = { appId: "chrome-wallet", apiKeyId: "chrome-wallet-key", apiKeyPrefix: "p" };
  });
  await app.register(sensible);
  await app.register(registerSessionAuth);
  await app.register(registerRateLimit);
  await app.register(registerAuthSessionRoutes, { prefix: "/v1" });
  await app.register(registerSigningRequestRoutes, { prefix: "/v1" });
  await app.register(registerRecoveryRoutes, { prefix: "/v1" });
  await app.register(registerIndexerRoutes, { prefix: "/v1" });
  app.get("/v1/plain", async () => ({ ok: true }));
  for (const url of ["/v1/health", "/v1/health/ready", "/v1/docs/json", "/documentation/json"]) {
    app.get(url, async () => ({ ok: true }));
  }
  await app.ready();
  return app;
}

type Hit = { ip?: string; install?: string };
function hit(app: Awaited<ReturnType<typeof buildServer>>, method: "GET" | "POST", url: string, opts: Hit = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? CLIENT };
  if (opts.install) headers["x-arch-install-id"] = opts.install;
  return app.inject({ method, url, remoteAddress: ALB, headers });
}

async function hitN(app: Awaited<ReturnType<typeof buildServer>>, n: number, ...args: Parameters<typeof hit> extends [any, ...infer R] ? R : never) {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await hit(app, ...args)).statusCode);
  return statuses;
}

describe("route-group rate limits, registered like production", () => {
  it("auth routes 429 at their limit, per route and per IP", async () => {
    const app = await buildServer("enforce");
    const max = RATE_LIMITS.auth.max;
    const first = await hit(app, "POST", "/v1/auth/session/challenge");
    expect(first.headers["x-ratelimit-limit"]).toBe(String(max));
    const rest = await hitN(app, max - 1, "POST", "/v1/auth/session/challenge");
    expect([first.statusCode, ...rest]).not.toContain(429);

    const over = await hit(app, "POST", "/v1/auth/session/challenge");
    expect(over.statusCode).toBe(429);
    expect(over.headers["retry-after"]).toBeDefined();
    expect(over.json()).toEqual({
      statusCode: 429,
      error: "TooManyRequests",
      message: "Rate limit exceeded, retry in 1 minute",
    });
    expect((await hit(app, "POST", "/v1/auth/session")).statusCode).not.toBe(429);
    expect((await hit(app, "POST", "/v1/auth/session/challenge", { ip: "198.51.100.1" })).statusCode).not.toBe(429);
    await app.close();
  });

  it("recovery routes 429 at their limit", async () => {
    const app = await buildServer("enforce");
    const max = RATE_LIMITS.recovery.max;
    const statuses = await hitN(app, max + 1, "POST", "/v1/recovery/email/init");
    expect(statuses.slice(0, max)).not.toContain(429);
    expect(statuses[max]).toBe(429);
    await app.close();
  });

  it("indexer routes use a per-install bucket shared across indexer routes, separate from global", async () => {
    const app = await buildServer("enforce");
    const max = RATE_LIMITS.indexer.max;
    const first = await hit(app, "GET", "/v1/indexer/btc/tip", { install: INSTALL_A });
    expect(first.headers["x-ratelimit-limit"]).toBe(String(max));
    const half = await hitN(app, max / 2 - 1, "GET", "/v1/indexer/btc/tip", { install: INSTALL_A });
    const other = await hitN(app, max / 2, "GET", "/v1/indexer/arch/network/stats", { install: INSTALL_A });
    expect([first.statusCode, ...half, ...other]).not.toContain(429);
    expect((await hit(app, "GET", "/v1/indexer/btc/tip", { install: INSTALL_A })).statusCode).toBe(429);

    // Another install behind the same IP, and the global bucket, are untouched.
    const b = await hit(app, "GET", "/v1/indexer/btc/tip", { install: INSTALL_B });
    expect(b.statusCode).not.toBe(429);
    expect(b.headers["x-ratelimit-remaining"]).toBe(String(max - 1));
    const plain = await hit(app, "GET", "/v1/plain");
    expect(plain.headers["x-ratelimit-limit"]).toBe(String(RATE_LIMITS.global.max));
    expect(plain.headers["x-ratelimit-remaining"]).toBe(String(RATE_LIMITS.global.max - 1));
    await app.close();
  });

  it("indexer routes fall back to app + IP without a well-formed install id", async () => {
    const app = await buildServer("enforce");
    const max = RATE_LIMITS.indexer.max;
    const none = await hit(app, "GET", "/v1/indexer/btc/tip");
    const malformed = await hit(app, "GET", "/v1/indexer/btc/tip", { install: "not a valid id!" });
    const otherIp = await hit(app, "GET", "/v1/indexer/btc/tip", { ip: "198.51.100.1" });
    expect(none.headers["x-ratelimit-remaining"]).toBe(String(max - 1));
    expect(malformed.headers["x-ratelimit-remaining"]).toBe(String(max - 2));
    expect(otherIp.headers["x-ratelimit-remaining"]).toBe(String(max - 1));
    await app.close();
  });

  it("a per-IP ceiling bounds rotating install ids", async () => {
    const app = await buildServer("enforce");
    const ceiling = RATE_LIMITS.indexer.ipCeiling!;
    const statuses: number[] = [];
    for (let i = 0; i < ceiling; i++) {
      const install = randomUUID();
      statuses.push((await hit(app, "GET", "/v1/indexer/btc/tip", { install })).statusCode);
    }
    expect(statuses).not.toContain(429);
    const over = await hit(app, "GET", "/v1/indexer/btc/tip", { install: randomUUID() });
    expect(over.statusCode).toBe(429);
    expect(over.headers["x-ratelimit-limit"]).toBe(String(ceiling));
    expect(over.headers["retry-after"]).toBeDefined();
    expect((await hit(app, "GET", "/v1/indexer/btc/tip", { ip: "198.51.100.1", install: INSTALL_A })).statusCode).not.toBe(429);
    await app.close();
  }, 30_000);

  it("send and signing routes keep their own bucket when indexer reads are exhausted", async () => {
    const app = await buildServer("enforce");
    await hitN(app, RATE_LIMITS.indexer.max, "GET", "/v1/indexer/arch/accounts/acct1/tokens", { install: INSTALL_A });
    expect((await hit(app, "GET", "/v1/indexer/btc/tip", { install: INSTALL_A })).statusCode).toBe(429);

    const max = RATE_LIMITS.send.max;
    const sendRoutes: Array<["GET" | "POST", string]> = [
      ["POST", "/v1/indexer/btc/tx"],
      ["GET", "/v1/indexer/btc/address/bc1qexample/utxo"],
      ["GET", "/v1/indexer/btc/fee-estimates"],
      ["POST", "/v1/signing-requests"],
      ["POST", "/v1/signing-requests/abc/submit"],
    ];
    const statuses: number[] = [];
    for (let i = 0; i < max; i++) {
      const [method, url] = sendRoutes[i % sendRoutes.length]!;
      const res = await hit(app, method, url, { install: INSTALL_A });
      if (i === 0) expect(res.headers["x-ratelimit-limit"]).toBe(String(max));
      statuses.push(res.statusCode);
    }
    expect(statuses).not.toContain(429);
    expect((await hit(app, "POST", "/v1/indexer/btc/tx", { install: INSTALL_A })).statusCode).toBe(429);
    await app.close();
  }, 30_000);

  it("ungrouped routes share the global app + IP bucket; health and docs stay exempt", async () => {
    const app = await buildServer("enforce");
    const max = RATE_LIMITS.global.max;
    const plain = await hitN(app, max / 2, "GET", "/v1/plain");
    const signingRead = await hitN(app, max / 2, "GET", "/v1/signing-requests/abc");
    expect([...plain, ...signingRead]).not.toContain(429);
    expect((await hit(app, "GET", "/v1/plain")).statusCode).toBe(429);
    expect((await hit(app, "GET", "/v1/plain", { ip: "198.51.100.1" })).statusCode).not.toBe(429);

    for (const url of ["/v1/health", "/v1/health/ready", "/v1/docs/json", "/documentation/json"]) {
      const res = await hit(app, "GET", url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["x-ratelimit-limit"], url).toBeUndefined();
    }
    await app.close();
  }, 30_000);
});

describe("log-only mode", () => {
  async function replay(mode: "enforce" | "log", requests: Array<() => Parameters<typeof hit>>) {
    const logs: any[] = [];
    const app = await buildServer(mode, logs);
    const seen: Array<{ status: number; limit?: string; remaining?: string; retryAfter?: string }> = [];
    for (const make of requests) {
      const res = await hit(...make().map((v, i) => (i === 0 ? app : v)) as Parameters<typeof hit>);
      seen.push({
        status: res.statusCode,
        limit: res.headers["x-ratelimit-limit"] as string,
        remaining: res.headers["x-ratelimit-remaining"] as string,
        retryAfter: res.headers["retry-after"] as string | undefined,
      });
    }
    await app.close();
    return { seen, warnings: logs.filter((l) => l.rateLimit) };
  }

  it("counts like enforce but logs instead of returning 429", async () => {
    const max = RATE_LIMITS.auth.max;
    const requests = Array.from({ length: max + 3 }, () => () =>
      [null, "POST", "/v1/auth/session/challenge"] as unknown as Parameters<typeof hit>,
    );
    const enforce = await replay("enforce", requests);
    const log = await replay("log", requests);

    expect(enforce.seen.filter((r) => r.status === 429)).toHaveLength(3);
    expect(log.seen.map((r) => r.status)).not.toContain(429);
    // Same counters, same headers, minus the retry-after that only a 429 carries.
    expect(log.seen.map((r) => [r.limit, r.remaining])).toEqual(enforce.seen.map((r) => [r.limit, r.remaining]));
    expect(log.seen.some((r) => r.retryAfter)).toBe(false);

    expect(enforce.warnings).toHaveLength(0);
    expect(log.warnings).toHaveLength(3);
    expect(log.warnings[0].rateLimit).toEqual({
      route: "POST /v1/auth/session/challenge",
      rule: "auth",
      key: "route:/v1/auth/session/challenge:ip:203.0.113.x",
      limit: max,
    });
    expect(log.warnings[0].level).toBe(40);
  });

  it("logs the per-IP ceiling with its count, and skips it for requests the install limit already caught", async () => {
    const ceiling = RATE_LIMITS.indexer.ipCeiling!;
    const installMax = RATE_LIMITS.indexer.max;
    // One looping install well past its own limit: in enforce mode the
    // over-limit requests never reach the IP ceiling, so they mustn't here.
    const looping = Array.from({ length: ceiling + 10 }, () => () =>
      [null, "GET", "/v1/indexer/btc/tip", { install: INSTALL_A }] as unknown as Parameters<typeof hit>,
    );
    const loop = await replay("log", looping);
    expect(loop.seen.map((r) => r.status)).not.toContain(429);
    expect(loop.warnings.every((w) => w.rateLimit.rule === "indexer")).toBe(true);
    expect(loop.warnings).toHaveLength(ceiling + 10 - installMax);

    const rotating = Array.from({ length: ceiling + 2 }, (_, i) => () =>
      [null, "GET", "/v1/indexer/btc/tip", { install: randomUUID() }] as unknown as Parameters<typeof hit>,
    );
    const rot = await replay("log", rotating);
    expect(rot.seen.map((r) => r.status)).not.toContain(429);
    expect(rot.warnings.map((w) => w.rateLimit)).toEqual([
      { route: "GET /v1/indexer/btc/tip", rule: "indexer-ip", key: "ip:203.0.113.x", limit: ceiling, count: ceiling + 1 },
      { route: "GET /v1/indexer/btc/tip", rule: "indexer-ip", key: "ip:203.0.113.x", limit: ceiling, count: ceiling + 2 },
    ]);
  }, 60_000);
});
