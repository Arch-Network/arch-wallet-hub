import type { Pool } from "pg";

// Global db pool instance - set by the db plugin, accessible to all routes
let dbPool: Pool | null = null;

export function setDbPool(pool: Pool) {
  dbPool = pool;
}

export function getDbPool(): Pool {
  if (!dbPool) {
    throw new Error("Database pool not initialized. Ensure registerDb plugin runs before routes.");
  }
  return dbPool;
}
