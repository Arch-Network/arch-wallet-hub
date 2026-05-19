-- Phase 1.10: persist the recovery email a user supplies at sign-up so
-- the recovery routes can find the user without trusting client-supplied
-- email values, and so a fresh-device flow (no local externalUserId)
-- can resolve candidate wallets by email.
--
-- Non-unique by design: one human may onboard multiple wallets with the
-- same address. The recovery flow returns all candidates and the user
-- picks which one to recover.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS recovery_email TEXT,
  ADD COLUMN IF NOT EXISTS recovery_email_set_at TIMESTAMPTZ;

-- Lookup path: "for a given app, find every user whose recovery email
-- matches the lowercased input". The expression index lets us do that
-- without forcing every caller to normalise on read.
CREATE INDEX IF NOT EXISTS idx_users_app_recovery_email_lower
  ON users (app_id, lower(recovery_email))
  WHERE recovery_email IS NOT NULL;
