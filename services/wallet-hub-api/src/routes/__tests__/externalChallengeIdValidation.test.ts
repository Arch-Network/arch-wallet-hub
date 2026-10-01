import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerSessionAuth } from "../../plugins/sessionAuth.js";
import { registerAuthSessionRoutes } from "../authSessions.js";

/**
 * Regression guard for the raw HTTP 500 on the BIP-322 external-wallet
 * session mint route:
 *
 *   POST /v1/auth/session/external { challengeId: "not-a-uuid", signature: "..." }
 *     -> 500 {"code":"22P02","message":"invalid input syntax for type uuid"}
 *
 * `auth_challenges.id` is a Postgres uuid column, so a malformed (non-UUID)
 * value used to reach the DB and throw 22P02, surfacing as a 500. The schema
 * now constrains `challengeId` to `format: "uuid"`, which rejects malformed
 * input with a clean 400 at validation time -- before the handler (and the DB)
 * ever run. The route is mounted without appAuth so validation is exercised
 * directly (a malformed body 400s before any DB access).
 */
async function buildApp() {
  const app = Fastify();
  await app.register(registerSessionAuth);
  await app.register(registerAuthSessionRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

describe("external session challengeId UUID validation (22P02 500 regression)", () => {
  it("400s a non-UUID challengeId on /auth/session/external", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/session/external",
      payload: { challengeId: "does-not-exist", signature: "AkcwRAIg..." },
    });
    expect(res.statusCode).toBe(400);
    // It must fail at schema validation, not as a leaked DB 22P02 error.
    expect(res.body).toContain("challengeId");
    expect(res.body).not.toContain("22P02");
    await app.close();
  });
});
