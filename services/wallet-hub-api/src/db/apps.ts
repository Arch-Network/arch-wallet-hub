import type { PoolClient } from "pg";

export type AppRow = {
  id: string;
  name: string;
  disabled_at: string | null;
  created_at: string;
};

export type AppApiKeyRow = {
  id: string;
  app_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
};

export async function createApp(client: PoolClient, params: { name: string }): Promise<AppRow> {
  const res = await client.query<AppRow>(
    `INSERT INTO apps (name) VALUES ($1) RETURNING id, name, disabled_at, created_at`,
    [params.name]
  );
  return res.rows[0]!;
}

export async function insertAppApiKey(client: PoolClient, params: {
  appId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
}): Promise<AppApiKeyRow> {
  const res = await client.query<AppApiKeyRow>(
    `
      INSERT INTO app_api_keys (app_id, name, key_hash, key_prefix)
      VALUES ($1,$2,$3,$4)
      RETURNING id, app_id, name, key_hash, key_prefix, revoked_at, created_at, last_used_at
    `,
    [params.appId, params.name, params.keyHash, params.keyPrefix]
  );
  return res.rows[0]!;
}

export async function getAppApiKeyByHash(client: PoolClient, params: { keyHash: string }): Promise<AppApiKeyRow | null> {
  const res = await client.query<AppApiKeyRow>(
    `SELECT id, app_id, name, key_hash, key_prefix, revoked_at, created_at, last_used_at FROM app_api_keys WHERE key_hash = $1`,
    [params.keyHash]
  );
  return res.rows[0] ?? null;
}

export async function touchAppApiKeyLastUsed(client: PoolClient, params: { id: string }) {
  await client.query(`UPDATE app_api_keys SET last_used_at = NOW() WHERE id = $1`, [params.id]);
}

export type UserRow = { id: string };

export async function getUserByExternalId(client: PoolClient, params: {
  appId: string;
  externalUserId: string;
}): Promise<UserRow | null> {
  const res = await client.query<UserRow>(
    `SELECT id FROM users WHERE app_id = $1 AND external_user_id = $2 AND external_user_id IS NOT NULL`,
    [params.appId, params.externalUserId]
  );
  return res.rows[0] ?? null;
}

export async function getOrCreateUserByExternalId(client: PoolClient, params: {
  appId: string;
  externalUserId: string;
}): Promise<UserRow> {
  const res = await client.query<UserRow>(
    `
      INSERT INTO users (app_id, external_user_id)
      VALUES ($1,$2)
      ON CONFLICT (app_id, external_user_id) WHERE external_user_id IS NOT NULL
      DO UPDATE SET external_user_id = EXCLUDED.external_user_id
      RETURNING id
    `,
    [params.appId, params.externalUserId]
  );
  return res.rows[0]!;
}
