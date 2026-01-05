import type { FastifyPluginAsync } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runMigrations } from "../db/migrations.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const registerDb: FastifyPluginAsync = async (server) => {
  const pool = new Pool({ connectionString: server.config.DATABASE_URL });
  server.decorate("db", pool);

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
