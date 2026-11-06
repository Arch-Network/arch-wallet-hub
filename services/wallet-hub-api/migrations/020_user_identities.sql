-- The linked-accounts list: every way a person can prove who they are.
--
-- One row per (app, kind, subject). `subject` is the stable identifier the
-- credential's own system assigns:
--   google  -> the OIDC `sub` claim (never the email: Google emails change,
--              `sub` never does)
--   apple   -> the OIDC `sub` claim
--   email   -> the lower-cased address
--   passkey -> the WebAuthn credential id (base64url)
--   wallet  -> the x-only pubkey of an external wallet (linked_wallets)
--
-- `issuer` and `audience` are the OIDC `iss` / `aud` the identity was
-- registered under, which is what Turnkey matches a login token against; a
-- second audience (another platform's client id) is a second row for the
-- same person. `email_at_link` is the email the provider reported when the
-- row was made, kept so a later login can detect an email change.
--
-- Append-mostly: a row is inserted on sign-up or link and its
-- `last_login_at` bumped on every login; unlinking deletes the row (and the
-- audit chain records it). Nothing here grants signing authority — that
-- stays with Turnkey's own credentials on the sub-organization.

CREATE TABLE IF NOT EXISTS user_identities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL
                 CHECK (kind IN ('email', 'google', 'apple', 'passkey', 'wallet')),
  subject        TEXT NOT NULL,
  issuer         TEXT,
  audience       TEXT,
  email_at_link  TEXT,
  verified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at  TIMESTAMPTZ,
  UNIQUE (app_id, kind, subject)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_app_user
  ON user_identities (app_id, user_id);

-- Backfill: every recovery email becomes an UNVERIFIED email identity, so
-- the person's linked-accounts list is complete from day one and a later
-- OTP verify only has to flip `verified_at`. Collisions (two users, one
-- email) keep the oldest user's row; the others stay reachable through
-- `users.recovery_email` as before.
INSERT INTO user_identities (app_id, user_id, kind, subject, email_at_link, verified_at, created_at)
SELECT DISTINCT ON (u.app_id, lower(u.recovery_email))
  u.app_id,
  u.id,
  'email',
  lower(u.recovery_email),
  u.recovery_email,
  NULL,
  COALESCE(u.recovery_email_set_at, u.created_at)
FROM users u
WHERE u.recovery_email IS NOT NULL
ORDER BY u.app_id, lower(u.recovery_email), u.created_at ASC
ON CONFLICT (app_id, kind, subject) DO NOTHING;

-- Turnkey resources opened by an OIDC login (`auth_method = 'oauth'`): the
-- root user has an oauthProviders entry and no authenticator or API key;
-- every session is registered through OAUTH_LOGIN.
ALTER TABLE turnkey_resources
  DROP CONSTRAINT IF EXISTS turnkey_resources_auth_method_check;
ALTER TABLE turnkey_resources
  ADD CONSTRAINT turnkey_resources_auth_method_check
  CHECK (auth_method IS NULL OR auth_method IN ('passkey', 'email', 'oauth'));

-- Replay protection for id tokens presented to the Hub: a token is accepted
-- once, for its own lifetime. Rows past `expires_at` are dead weight and
-- can be swept by any job; nothing reads them after expiry.
CREATE TABLE IF NOT EXISTS oidc_replay (
  token_hash  TEXT PRIMARY KEY,
  app_id      UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oidc_replay_expires_at ON oidc_replay (expires_at);
