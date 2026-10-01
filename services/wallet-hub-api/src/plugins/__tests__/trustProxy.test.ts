import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { TRUST_PROXY_HOPS } from "../../server.js";
import { keyForRequest } from "../rateLimit.js";
import { registerRequireHttps } from "../requireHttps.js";

/**
 * One trusted hop (the ALB / nginx). Anything a client puts in
 * X-Forwarded-For before that hop's appended entry must not become
 * `request.ip`, or the per-IP rate-limit buckets are client-chosen.
 */
const ALB = "172.31.40.10";
const CLIENT = "203.0.113.9";

async function buildApp() {
  const app = Fastify({ trustProxy: TRUST_PROXY_HOPS });
  app.decorate("config", { REQUIRE_HTTPS: true } as never);
  await app.register(registerRequireHttps);
  app.addHook("onRequest", async (request) => {
    (request as any).app = { appId: "app", apiKeyId: "key" };
  });
  app.get("/v1/whoami", async (request) => ({ ip: request.ip, key: keyForRequest(request) }));
  await app.ready();
  return app;
}

describe("trustProxy hop count", () => {
  it("ignores client-supplied X-Forwarded-For entries beyond the trusted hop", async () => {
    const app = await buildApp();
    const keys = new Set<string>();
    for (const spoof of ["6.6.6.6", "1.1.1.1, 2.2.2.2", "10.0.0.1"]) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/whoami",
        remoteAddress: ALB,
        headers: { "x-forwarded-for": `${spoof}, ${CLIENT}`, "x-forwarded-proto": "https" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ip).toBe(CLIENT);
      keys.add(res.json().key);
    }
    expect([...keys]).toEqual([`app:key:ip:${CLIENT}`]);
    await app.close();
  });

  it("requireHttps goes by the proxy's (last) X-Forwarded-Proto entry, not a client-prepended one", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      remoteAddress: ALB,
      headers: { "x-forwarded-for": CLIENT, "x-forwarded-proto": "https, http" },
    });
    expect(res.statusCode).toBe(426);
    await app.close();
  });
});
