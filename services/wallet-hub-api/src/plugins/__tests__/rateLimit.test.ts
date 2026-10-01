import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  AUTH_ROUTE_RATE_LIMIT,
  RECOVERY_ROUTE_RATE_LIMIT,
  keyForRequest,
  registerRateLimit,
} from "../rateLimit.js";

/**
 * Verifies the RATE_LIMIT_ENABLED master switch.
 *
 * When enabled, @fastify/rate-limit is registered and adds its
 * `x-ratelimit-*` headers to responses. When disabled, the plugin returns
 * early without registering, so those headers never appear — which also
 * makes every route-level `config.rateLimit` override inert (they only
 * apply when the global plugin is registered).
 */
async function buildApp(rateLimitEnabled: boolean) {
  const app = Fastify();
  app.decorate("config", { RATE_LIMIT_ENABLED: rateLimitEnabled } as any);
  await app.register(registerRateLimit);
  app.get("/ping", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("registerRateLimit gating", () => {
  it("registers the limiter (adds x-ratelimit headers) when enabled", async () => {
    const app = await buildApp(true);
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    await app.close();
  });

  it("skips the limiter entirely when disabled", async () => {
    const app = await buildApp(false);
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    await app.close();
  });
});

describe("rate-limit keys and route caps", () => {
  it("buckets per client IP within one shared app key", () => {
    const a = keyForRequest({ app: { apiKeyId: "k1" }, ip: "10.0.0.1" } as any);
    const b = keyForRequest({ app: { apiKeyId: "k1" }, ip: "10.0.0.2" } as any);
    expect(a).not.toBe(b);
  });

  it.each([
    ["auth", AUTH_ROUTE_RATE_LIMIT, 20],
    ["recovery", RECOVERY_ROUTE_RATE_LIMIT, 10],
  ])("caps %s routes per IP and 429s past the cap", async (_name, limit, max) => {
    const app = Fastify();
    app.decorate("config", { RATE_LIMIT_ENABLED: true } as any);
    await app.register(registerRateLimit);
    app.post("/limited", { config: limit }, async () => ({ ok: true }));
    await app.ready();

    const hit = (ip: string) => app.inject({ method: "POST", url: "/limited", remoteAddress: ip });
    for (let i = 0; i < max; i++) expect((await hit("10.0.0.1")).statusCode).toBe(200);
    expect((await hit("10.0.0.1")).statusCode).toBe(429);
    expect((await hit("10.0.0.2")).statusCode).toBe(200);
    await app.close();
  });
});
