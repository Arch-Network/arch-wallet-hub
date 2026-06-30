import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerRateLimit } from "../rateLimit.js";

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
