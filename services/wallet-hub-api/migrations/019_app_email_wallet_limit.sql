-- Per-app cap on wallets that share one recovery email.
--
-- NULL (the default) keeps today's behavior: the extension and the
-- mobile app may create many wallets for one email, and recovery lists
-- every match. A positive integer locks that app id. Create requests
-- cannot raise or clear the cap; only the platform admin API can.
--
-- The claim row is inserted before the Turnkey call so two concurrent
-- creates cannot both pass a count. It is removed when the wallet row
-- commits (the resource count takes over) or when the create fails.
-- Claims older than the reservation TTL are ignored so a crashed
-- request cannot hold an email forever.

ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS email_wallet_limit INTEGER;

ALTER TABLE apps
  DROP CONSTRAINT IF EXISTS apps_email_wallet_limit_check;

ALTER TABLE apps
  ADD CONSTRAINT apps_email_wallet_limit_check
  CHECK (email_wallet_limit IS NULL OR email_wallet_limit >= 1);

-- Serializes creators for one (app, email) pair. Unlimited apps never
-- touch this table.
CREATE TABLE IF NOT EXISTS email_wallet_locks (
  app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL,
  PRIMARY KEY (app_id, email_normalized)
);

-- One row per in-flight create, not per user. A second concurrent
-- create for the same user must consume a second slot.
CREATE TABLE IF NOT EXISTS email_wallet_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_wallet_claims_app_email
  ON email_wallet_claims (app_id, email_normalized);
