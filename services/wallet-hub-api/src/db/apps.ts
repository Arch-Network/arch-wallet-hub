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
  /** Owning app's `disabled_at`; only populated by getAppApiKeyByHash. */
  app_disabled_at?: string | null;
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
    `
      SELECT k.id, k.app_id, k.name, k.key_hash, k.key_prefix,
             k.revoked_at, k.created_at, k.last_used_at,
             a.disabled_at AS app_disabled_at
      FROM app_api_keys k
      JOIN apps a ON a.id = k.app_id
      WHERE k.key_hash = $1
    `,
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

/**
 * Store / replace the recovery email for a user. Idempotent: passing
 * the same email twice is a no-op except for refreshing the
 * `recovery_email_set_at` timestamp. Pass `null` to clear (kept for a
 * future "delete recovery email" surface; not exposed today).
 */
export async function updateUserRecoveryEmail(client: PoolClient, params: {
  appId: string;
  userId: string;
  email: string | null;
}): Promise<void> {
  const normalised = params.email ? params.email.trim().toLowerCase() : null;
  // `$3` shows up in two contexts here: a column-typed assignment
  // (`recovery_email = $3` → text) and a type-agnostic predicate
  // (`$3 IS NULL` inside the CASE). On node-postgres the parameter
  // is sent with no OID, leaving Postgres to infer from query text
  // alone; on certain planner versions the IS NULL context wins and
  // Postgres errors at prepare time with `42P08 -- could not
  // determine data type of parameter $3`. Casting once forces the
  // type so neither context is ambiguous.
  await client.query(
    `
      UPDATE users
      SET recovery_email = $3::text,
          recovery_email_set_at = CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END
      WHERE id = $1 AND app_id = $2
    `,
    [params.userId, params.appId, normalised]
  );
}

export type UserRecoveryRow = {
  id: string;
  external_user_id: string | null;
  recovery_email: string | null;
};

/**
 * Find every user in `appId` whose recovery email matches the input
 * (case-insensitive). Returns 0+ rows; the recovery init endpoint
 * walks each one to mint per-sub-org OTPs.
 */
export async function findUsersByRecoveryEmail(client: PoolClient, params: {
  appId: string;
  email: string;
}): Promise<UserRecoveryRow[]> {
  const normalised = params.email.trim().toLowerCase();
  if (!normalised) return [];
  const res = await client.query<UserRecoveryRow>(
    `
      SELECT id, external_user_id, recovery_email
      FROM users
      WHERE app_id = $1 AND lower(recovery_email) = $2
      ORDER BY created_at ASC
    `,
    [params.appId, normalised]
  );
  return res.rows;
}
