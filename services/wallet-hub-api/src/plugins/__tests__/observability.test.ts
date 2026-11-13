import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerCors } from "../cors.js";
import { genRequestId, registerObservability } from "../observability.js";

/**
 * Regression guard for the globally-missing `request.completed` log event.
 *
 * `registerObservability` adds an `onResponse` hook. If it is registered as a
 * bare (non-fastify-plugin) async plugin, the hook is confined to the plugin's
 * encapsulated child scope and never fires for routes registered in sibling
 * scopes — so `request.completed` was emitted for ZERO requests in production
 * (same class of bug as the pre-fix registerDb encapsulation).
 *
 * Wrapping it in `fastify-plugin` hoists the hook to the root instance so it
 * fires for ALL routes. We assert that here by registering the plugin and a
 * sibling route, then confirming the structured event is logged at `info`.
 */
describe("observability request.completed hook", () => {
  it("fires for routes registered in sibling scopes", async () => {
    const logged: Array<{ obj: unknown; msg?: string }> = [];

    const app = Fastify({
      logger: {
        level: "info",
        // Capture structured log records so we can assert on the event.
        stream: {
          write(line: string) {
            const rec = JSON.parse(line);
            logged.push({ obj: rec, msg: rec.msg });
          },
        },
      },
    });

    await app.register(registerObservability);

    // Route registered as a SIBLING of the observability plugin — exactly the
    // shape that previously failed to trigger the encapsulated hook.
    await app.register(async (sibling) => {
      sibling.get("/ping", async () => ({ ok: true }));
    });

    await app.ready();

    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);

    const completed = logged.find((l) => l.msg === "request.completed");
    expect(completed).toBeDefined();

    const rec = completed!.obj as Record<string, unknown>;
    expect(rec.method).toBe("GET");
    expect(rec.url).toBe("/ping");
    expect(rec.statusCode).toBe(200);
    expect(typeof rec.responseTimeMs).toBe("number");

    await app.close();
  });
});

/**
 * A client reports the `x-request-id` it was answered with, and that id
 * has to find the request's log line. The options mirror `createServer`.
 */
describe("request ids", () => {
  async function buildApp() {
    const logged: Array<Record<string, unknown>> = [];
    const app = Fastify({
      logger: { level: "info", stream: { write: (line: string) => logged.push(JSON.parse(line)) } },
      requestIdHeader: false,
      genReqId: genRequestId,
    });
    await app.register(registerObservability);
    await app.register(async (sibling) => {
      sibling.addHook("onRequest", async (request, reply) => {
        if (request.headers["x-api-key"] === "bad") {
          return reply.code(401).send({ message: "Invalid API key" });
        }
      });
      sibling.get("/ping", async () => ({ ok: true }));
      sibling.get("/v1/signing-requests/boom", async () => {
        throw new Error("database is down");
      });
      // As routes/indexer.ts answers when the indexer fails.
      sibling.get("/v1/indexer/missing", async (request, reply) => {
        request.upstreamStatus = 404;
        return reply.code(502).send({ statusCode: 502, error: "BadGateway", message: "Indexer error 404" });
      });
      sibling.get("/v1/indexer/unreachable", async (_request, reply) =>
        reply.code(502).send({ statusCode: 502, error: "BadGateway", message: "fetch failed" }),
      );
    });
    await app.ready();
    const completed = () => logged.filter((l) => l.msg === "request.completed");
    return { app, completed };
  }

  it("answers with the id the request is logged under", async () => {
    const { app, completed } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/ping" });
    const id = res.headers["x-request-id"];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(completed().map((l) => l.reqId)).toEqual([id]);
    await app.close();
  });

  it("names the request on replies sent by hooks, on errors and on unknown routes", async () => {
    const { app, completed } = await buildApp();
    const rejected = await app.inject({ method: "GET", url: "/ping", headers: { "x-api-key": "bad" } });
    const failed = await app.inject({ method: "GET", url: "/v1/signing-requests/boom" });
    const missing = await app.inject({ method: "GET", url: "/nope" });
    expect([rejected.statusCode, failed.statusCode, missing.statusCode]).toEqual([401, 500, 404]);
    expect(completed().map((l) => l.reqId)).toEqual([
      rejected.headers["x-request-id"],
      failed.headers["x-request-id"],
      missing.headers["x-request-id"],
    ]);
    await app.close();
  });

  it("keeps a caller's id when it is a plain token", async () => {
    const { app, completed } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/ping", headers: { "x-request-id": "wallet-7f3a.1" } });
    expect(res.headers["x-request-id"]).toBe("wallet-7f3a.1");
    expect(completed()[0].reqId).toBe("wallet-7f3a.1");
    await app.close();
  });

  it("replaces a caller's id that is not a plain token", async () => {
    const { app, completed } = await buildApp();
    for (const sent of ['x","level":60,"msg":"forged', "two words", "a".repeat(65), ""]) {
      const res = await app.inject({ method: "GET", url: "/ping", headers: { "x-request-id": sent } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(completed().every((l) => /^[0-9a-f-]{36}$/.test(String(l.reqId)))).toBe(true);
    await app.close();
  });

  it("lets a browser caller on an allowed origin read the id", async () => {
    const app = Fastify({ requestIdHeader: false, genReqId: genRequestId });
    app.decorate("config", { NODE_ENV: "test", CORS_ALLOW_ORIGINS: "https://app.example" } as never);
    await app.register(registerCors);
    await app.register(registerObservability);
    app.get("/ping", async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/ping", headers: { origin: "https://app.example" } });
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example");
    expect(res.headers["access-control-expose-headers"]).toBe("x-request-id");
    expect(res.headers["x-request-id"]).toBeTruthy();
    await app.close();
  });

  it("logs the fields the API error alarms filter on", async () => {
    // infra/cdk/lib/api-error-alarms.ts matches msg and a numeric statusCode.
    const { app, completed } = await buildApp();
    await app.inject({ method: "GET", url: "/v1/signing-requests/boom" });
    expect(completed()[0]).toMatchObject({ msg: "request.completed", statusCode: 500 });
    await app.close();
  });

  it("logs the upstream's status for the 502 alarm, and no such field when there is none", async () => {
    // The UpstreamErrors filter in infra/cdk/lib/api-error-alarms.ts leaves
    // out a 502 whose numeric upstreamStatus is 404, and counts a 502 line
    // that has no upstreamStatus field. A null would be neither.
    const { app, completed } = await buildApp();
    await app.inject({ method: "GET", url: "/v1/indexer/missing" });
    await app.inject({ method: "GET", url: "/v1/indexer/unreachable" });
    await app.inject({ method: "GET", url: "/ping" });
    const [missing, unreachable, ok] = completed();
    expect(missing).toMatchObject({ msg: "request.completed", statusCode: 502, upstreamStatus: 404 });
    expect(unreachable).toMatchObject({ msg: "request.completed", statusCode: 502 });
    expect(unreachable).not.toHaveProperty("upstreamStatus");
    expect(ok).not.toHaveProperty("upstreamStatus");
    await app.close();
  });
});
