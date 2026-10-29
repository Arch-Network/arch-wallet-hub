-- A person is a verified email.
--
-- `users` has been one row per (app, external_user_id): one per extension
-- install, one per web sign-up. Nothing tied two of those rows to one human,
-- and `recovery_email` (migration 009) is a hint any caller with the app key
-- can write, so it could never be a lookup key worth trusting.
--
-- `primary_email` is the email a credential the user controls has proven:
-- an OIDC id token whose issuer says `email_verified`, or an OTP code the
-- inbox answered. It is unique per app ONLY where verified; unverified
-- rows (legacy recovery emails) may still collide, exactly as today.
--
-- Additive only. Existing rows keep `recovery_email` untouched; the OAuth
-- routes and a verified OTP set `primary_email` going forward.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS primary_email TEXT,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_app_verified_primary_email
  ON users (app_id, lower(primary_email))
  WHERE primary_email IS NOT NULL AND email_verified_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_app_primary_email_lower
  ON users (app_id, lower(primary_email))
  WHERE primary_email IS NOT NULL;
