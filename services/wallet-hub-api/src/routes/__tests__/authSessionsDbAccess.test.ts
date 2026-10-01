import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerDb } from "../../plugins/db.js";
import { getDbPool } from "../../db/pool.js";

/**
 * Regression guard for the intermittent HTTP 500s on
 * POST /v1/auth/session/challenge:
 *
 *   TypeError: Cannot read properties of undefined (reading 'connect')
 *     at withDbTransaction (db/tx.js)  -> pool.connect()
 *     at authSessions.js               -> withDbTransaction(server.db, ...)
 *
 * `registerDb` is a plain (non-fastify-plugin) async plugin, so it runs in
 * its own encapsulated scope. The `server.decorate("db", pool)` it does is
 * therefore NOT visible to sibling route plugins, leaving `server.db`
 * undefined in the auth-session handlers. Routes must use the `getDbPool()`
 * global accessor (the documented workaround) instead.
 */
describe("auth/session DB access (challenge 500 regression)", () => {
  it("registerDb's decoration does not leak to siblings, but getDbPool() works", async () => {
    const app = Fastify();
    // new Pool() is lazy; it never dials the DB unless connect()/query() is
    // called, so this is safe to construct without a live Postgres.
    app.decorate("config", {
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      DB_RUN_MIGRATIONS: false,
    } as never);

    await app.register(registerDb);

    let dbInSibling: unknown = "unset";
    await app.register(async (sibling) => {
      dbInSibling = (sibling as { db?: unknown }).db;
    });

    await app.ready();

    // The encapsulation boundary is exactly why the handlers must not use
    // server.db: it is undefined in sibling scopes.
    expect(dbInSibling).toBeUndefined();

    // The accessor the handlers actually use returns a usable pool.
    const pool = getDbPool();
    expect(pool).toBeDefined();
    expect(typeof pool.connect).toBe("function");

    await app.close();
  });
});
