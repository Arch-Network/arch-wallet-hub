import type { FastifyPluginAsync } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runMigrations } from "../db/migrations.js";
import { setDbPool } from "../db/pool.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const registerDb: FastifyPluginAsync = async (server) => {
  // env.ts guarantees DATABASE_URL is set after env validation (either
  // passed directly or synthesized from DB_HOST/DB_PORT/etc.), but the
  // Zod schema types it as optional. Re-check at the boundary so tsc
  // can narrow it for the rest of this function.
  const rawConnStr = server.config.DATABASE_URL;
  if (!rawConnStr) {
    throw new Error("DATABASE_URL is required but missing after env validation");
  }
  const needsSsl = /sslmode=(require|verify)/i.test(rawConnStr);
  const connStr = needsSsl
    ? rawConnStr.replace(/[?&]sslmode=(require|verify-ca|verify-full|no-verify)[^&]*/gi, "")
    : rawConnStr;
  const pool = new Pool({
    connectionString: connStr,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  server.decorate("db", pool);
  
  // Also store globally for routes that can't access server.db in scoped plugins
  setDbPool(pool);

  server.addHook("onClose", async () => {
    await pool.end();
  });

  if (server.config.DB_RUN_MIGRATIONS) {
    // In ESM builds, dist/ mirrors src/ so this resolves to services/wallet-hub-api/migrations
    const migrationsDir = path.resolve(__dirname, "../../migrations");
    server.log.info({ migrationsDir }, "running migrations");
    await runMigrations(pool, migrationsDir);
  }
};
