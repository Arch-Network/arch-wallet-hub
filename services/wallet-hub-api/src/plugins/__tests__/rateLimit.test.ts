import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { installKeyForRequest, keyForRequest, maskKey, registerRateLimit } from "../rateLimit.js";

/**
 * Verifies the RATE_LIMIT_ENABLED master switch.
 *
 * When enforcing or logging, @fastify/rate-limit is registered and adds
 * its `x-ratelimit-*` headers to responses. When off, the plugin returns
 * early without registering, so those headers never appear.
 */
async function buildApp(mode: "enforce" | "log" | "off") {
  const app = Fastify();
  app.decorate("config", { RATE_LIMIT_ENABLED: mode } as any);
  await app.register(registerRateLimit);
  app.get("/ping", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("registerRateLimit gating", () => {
  it.each(["enforce", "log"] as const)("registers the limiter (adds x-ratelimit headers) in %s mode", async (mode) => {
    const app = await buildApp(mode);
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("300");
    await app.close();
  });

  it("skips the limiter entirely when off", async () => {
    const app = await buildApp("off");
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    await app.close();
  });
});

describe("rate-limit keys", () => {
  const req = (headers: Record<string, string>, ip = "10.0.0.1") =>
    ({ app: { apiKeyId: "k1" }, ip, headers }) as any;

  it("buckets per client IP within one shared app key", () => {
    expect(keyForRequest(req({}, "10.0.0.1"))).not.toBe(keyForRequest(req({}, "10.0.0.2")));
  });

  it("keys by app + install id when a well-formed one is sent", () => {
    const install = "4f1c2d3e-aaaa-4bbb-8ccc-0123456789ab";
    expect(installKeyForRequest(req({ "x-arch-install-id": install }))).toBe(`app:k1:install:${install}`);
    // The extension's non-UUID fallback id is accepted too.
    expect(installKeyForRequest(req({ "x-arch-install-id": "1727750000000-k3j4h5g6f7" }))).toBe(
      "app:k1:install:1727750000000-k3j4h5g6f7",
    );
  });

  it.each([
    ["too short", "abc123"],
    ["too long", "a".repeat(65)],
    ["bad charset", "has spaces in it ok"],
    ["delimiter", "abcdefgh:ip:1.2.3.4"],
  ])("treats a malformed install id (%s) as absent", (_why, value) => {
    expect(installKeyForRequest(req({ "x-arch-install-id": value }))).toBe("app:k1:ip:10.0.0.1");
  });

  it("falls back to app + IP without an install id, and ignores the id without an app key", () => {
    expect(installKeyForRequest(req({}))).toBe("app:k1:ip:10.0.0.1");
    expect(
      installKeyForRequest({ ip: "10.0.0.1", headers: { "x-arch-install-id": "abcdefgh12345678" } } as any),
    ).toBe("ip:10.0.0.1");
  });

  it("masks install ids, app key ids and IPs for logging", () => {
    expect(maskKey("app:9f2c1e0a-1111:install:4f1c2d3e-aaaa-4bbb:ip:203.0.113.7")).toBe(
      "app:9f2c1e…:install:4f1c2d…:ip:203.0.113.x",
    );
    expect(maskKey("app:9f2c1e0a-1111:ip:2001:db8:85a3:0:0:8a2e:370:7334")).toBe("app:9f2c1e…:ip:2001:db8:85a3:…");
    expect(maskKey("route:/v1/auth/session/challenge:ip:198.51.100.23")).toBe(
      "route:/v1/auth/session/challenge:ip:198.51.100.x",
    );
  });
});
