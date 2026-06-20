import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerSessionAuth } from "../../plugins/sessionAuth.js";
import { registerAuthSessionRoutes } from "../authSessions.js";
import { registerBtcTransactionRoutes } from "../btcTransactions.js";

/**
 * Regression guard for the raw HTTP 500 on routes that accept a
 * `turnkeyResourceId`:
 *
 *   POST /v1/auth/session/challenge { turnkeyResourceId: "not-a-uuid" }
 *     -> 500 {"code":"22P02","message":"invalid input syntax for type uuid"}
 *
 * `turnkey_resources.id` is a Postgres uuid column, so a malformed (non-UUID)
 * value used to reach the DB and throw 22P02, surfacing as a 500. The schemas
 * now constrain the field to `format: "uuid"`, which rejects malformed input
 * with a clean 400 at validation time -- before the handler (and the DB) ever
 * run. These routes are mounted without appAuth so validation is exercised
 * directly (a malformed body 400s before any DB access).
 */
async function buildApp() {
  const app = Fastify();
  await app.register(registerSessionAuth);
  await app.register(registerAuthSessionRoutes, { prefix: "/v1" });
  await app.register(registerBtcTransactionRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

describe("turnkeyResourceId UUID validation (22P02 500 regression)", () => {
  it("400s a non-UUID turnkeyResourceId on /auth/session/challenge", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/session/challenge",
      payload: { externalUserId: "user-1", turnkeyResourceId: "not-a-uuid-resource" },
    });
    expect(res.statusCode).toBe(400);
    // It must fail at schema validation, not as a leaked DB 22P02 error.
    expect(res.body).toContain("turnkeyResourceId");
    expect(res.body).not.toContain("22P02");
    await app.close();
  });

  it("400s a non-UUID turnkeyResourceId on /btc/estimate-fee", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/btc/estimate-fee",
      payload: {
        externalUserId: "user-1",
        turnkeyResourceId: "not-a-uuid-resource",
        toAddress: "bc1qexampleexampleexampleexampleexampleex",
        amountSats: 1000,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("turnkeyResourceId");
    expect(res.body).not.toContain("22P02");
    await app.close();
  });
});
