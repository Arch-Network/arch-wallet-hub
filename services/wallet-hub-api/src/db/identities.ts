/**
 * The person layer (migrations 019 / 020): `users.primary_email` and
 * `user_identities`. Every query is scoped by app_id, like the rest of
 * `db/`, so one app's Google subject can never resolve another app's user.
 */

import type { PoolClient } from "pg";
import crypto from "node:crypto";

export type IdentityKind = "email" | "google" | "apple" | "passkey" | "wallet";

export type UserIdentityRow = {
  id: string;
  app_id: string;
  user_id: string;
  kind: IdentityKind;
  subject: string;
  issuer: string | null;
  audience: string | null;
  email_at_link: string | null;
  verified_at: string | null;
  created_at: string;
  last_login_at: string | null;
};

export type PersonRow = {
  id: string;
  external_user_id: string | null;
  primary_email: string | null;
  email_verified_at: string | null;
  recovery_email: string | null;
  created_at: string;
};

/** Canonical person ids: `usr_` + 32 hex, distinguishable at a glance from an install id. */
export function newPersonExternalId(): string {
  return `usr_${crypto.randomBytes(16).toString("hex")}`;
}

export async function getIdentity(
  client: PoolClient,
  params: { appId: string; kind: IdentityKind; subject: string },
): Promise<UserIdentityRow | null> {
  const res = await client.query<UserIdentityRow>(
    `SELECT * FROM user_identities WHERE app_id = $1 AND kind = $2 AND subject = $3`,
    [params.appId, params.kind, params.subject],
  );
  return res.rows[0] ?? null;
}

export async function listIdentitiesForUser(
  client: PoolClient,
  params: { appId: string; userId: string },
): Promise<UserIdentityRow[]> {
  const res = await client.query<UserIdentityRow>(
    `SELECT * FROM user_identities WHERE app_id = $1 AND user_id = $2 ORDER BY created_at ASC`,
    [params.appId, params.userId],
  );
  return res.rows;
}

export async function insertIdentity(
  client: PoolClient,
  params: {
    appId: string;
    userId: string;
    kind: IdentityKind;
    subject: string;
    issuer: string | null;
    audience: string | null;
    emailAtLink: string | null;
    verified: boolean;
  },
): Promise<UserIdentityRow> {
  const res = await client.query<UserIdentityRow>(
    `
      INSERT INTO user_identities (app_id, user_id, kind, subject, issuer, audience, email_at_link, verified_at, last_login_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::boolean THEN NOW() ELSE NULL END, NOW())
      ON CONFLICT (app_id, kind, subject) DO UPDATE
        SET last_login_at = NOW(),
            verified_at = COALESCE(user_identities.verified_at, EXCLUDED.verified_at)
      RETURNING *
    `,
    [params.appId, params.userId, params.kind, params.subject, params.issuer, params.audience, params.emailAtLink, params.verified],
  );
  return res.rows[0]!;
}

export async function touchIdentityLogin(client: PoolClient, params: { id: string }): Promise<void> {
  await client.query(`UPDATE user_identities SET last_login_at = NOW() WHERE id = $1`, [params.id]);
}

export async function getPerson(client: PoolClient, params: { appId: string; userId: string }): Promise<PersonRow | null> {
  const res = await client.query<PersonRow>(
    `SELECT id, external_user_id, primary_email, email_verified_at, recovery_email, created_at
       FROM users WHERE app_id = $1 AND id = $2`,
    [params.appId, params.userId],
  );
  return res.rows[0] ?? null;
}

/** The person a VERIFIED email already belongs to, if any: the collision check before a sign-up. */
export async function getPersonByVerifiedEmail(
  client: PoolClient,
  params: { appId: string; email: string },
): Promise<PersonRow | null> {
  const res = await client.query<PersonRow>(
    `SELECT id, external_user_id, primary_email, email_verified_at, recovery_email, created_at
       FROM users
      WHERE app_id = $1 AND lower(primary_email) = lower($2) AND email_verified_at IS NOT NULL
      LIMIT 1`,
    [params.appId, params.email],
  );
  return res.rows[0] ?? null;
}

/** A new person: canonical id, email as the provider reported it, verified only when the provider said so. */
export async function createPerson(
  client: PoolClient,
  params: { appId: string; externalUserId?: string; email: string | null; emailVerified: boolean },
): Promise<PersonRow> {
  const externalUserId = params.externalUserId ?? newPersonExternalId();
  const res = await client.query<PersonRow>(
    `
      INSERT INTO users (app_id, external_user_id, primary_email, email_verified_at, recovery_email, recovery_email_set_at)
      VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN NOW() ELSE NULL END, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END)
      RETURNING id, external_user_id, primary_email, email_verified_at, recovery_email, created_at
    `,
    [params.appId, externalUserId, params.email, params.emailVerified],
  );
  return res.rows[0]!;
}

/** Promote a verified email onto an existing person (an OTP verify, or a provider that vouches for it). */
export async function setVerifiedPrimaryEmail(
  client: PoolClient,
  params: { appId: string; userId: string; email: string },
): Promise<void> {
  await client.query(
    `
      UPDATE users
         SET primary_email = COALESCE(primary_email, $3),
             email_verified_at = CASE WHEN lower(COALESCE(primary_email, $3)) = lower($3) THEN COALESCE(email_verified_at, NOW()) ELSE email_verified_at END
       WHERE app_id = $1 AND id = $2
    `,
    [params.appId, params.userId, params.email],
  );
}

/** Replay guard for id tokens: true if this token was already accepted. */
export async function recordOidcTokenUse(
  client: PoolClient,
  params: { appId: string; tokenHash: string; expiresAt: Date },
): Promise<{ replayed: boolean }> {
  const res = await client.query(
    `INSERT INTO oidc_replay (token_hash, app_id, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (token_hash) DO NOTHING`,
    [params.tokenHash, params.appId, params.expiresAt.toISOString()],
  );
  return { replayed: res.rowCount === 0 };
}

/** Every pubkey the Hub holds for the person, for the ID token's `wallets[]`. */
export async function listWalletPubkeysForUser(
  client: PoolClient,
  params: { appId: string; userId: string },
): Promise<string[]> {
  const res = await client.query<{ pubkey: string }>(
    `
      SELECT default_public_key_hex AS pubkey FROM turnkey_resources
       WHERE app_id = $1 AND user_id = $2 AND default_public_key_hex IS NOT NULL AND key_verified_at IS NOT NULL
      UNION
      SELECT public_key_hex AS pubkey FROM linked_wallets
       WHERE app_id = $1 AND user_id = $2 AND public_key_hex IS NOT NULL
    `,
    [params.appId, params.userId],
  );
  return res.rows.map((r) => r.pubkey);
}
