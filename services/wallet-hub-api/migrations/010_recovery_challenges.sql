-- Phase 1.10: persisted recovery challenges so /recovery/email/verify
-- can authenticate the OTP code against the otpId(s) we minted at
-- /recovery/email/init.
--
-- One row per init call. `candidates` lists every (resourceId,
-- userId, organizationId, otpId, label, addressMasked) the lookup
-- matched -- the user picks one of these at verify time. We persist
-- the otpId per candidate because Turnkey's OTP_AUTH activity is
-- scoped to a specific sub-organization (one OTP per sub-org per
-- challenge).
--
-- `email_hash` is sha256(lower(email)) and is used for rate limiting
-- without storing the plaintext email in this table. The plaintext
-- lives only on the users row and the audit log.

CREATE TABLE IF NOT EXISTS recovery_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,
  candidates JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'expired', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_recovery_challenges_email_hash
  ON recovery_challenges (app_id, email_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recovery_challenges_expiry
  ON recovery_challenges (expires_at)
  WHERE status = 'pending';
