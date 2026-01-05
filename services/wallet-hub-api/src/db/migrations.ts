import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

type AppliedMigration = { id: string };

async function ensureMigrationsTable(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function listMigrationFiles(migrationsDir: string) {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const res = await pool.query<AppliedMigration>(
    `SELECT id FROM schema_migrations ORDER BY applied_at ASC`
  );
  return new Set(res.rows.map((r) => r.id));
}

export async function runMigrations(pool: Pool, migrationsDir: string) {
  await ensureMigrationsTable(pool);

  const [files, applied] = await Promise.all([
    listMigrationFiles(migrationsDir),
    getAppliedMigrations(pool)
  ]);

  for (const file of files) {
    if (applied.has(file)) continue;

    const fullPath = path.join(migrationsDir, file);
    const sql = await fs.readFile(fullPath, "utf8");

    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [file]);
      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }
  }
}
