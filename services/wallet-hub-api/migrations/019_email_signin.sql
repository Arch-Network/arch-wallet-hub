-- Email sign-in proves the inbox before any wallet exists, then reuses or
-- creates exactly one wallet for that (app, email).
--
--   * recovery_challenges.otp_id: the Turnkey INIT_OTP_V3 id of a
--     /recovery/email/signin challenge. NULL on /recovery/email/init
--     challenges, whose OTP ids live on each candidate.
--   * turnkey_resources.verified_email: the lowercased email whose OTP
--     resolved to this wallet. Written only after VERIFY_OTP_V2 succeeds,
--     and unique per app, so an email signs in to one wallet. Wallets
--     created before this migration get it on their first sign-in.

ALTER TABLE recovery_challenges
  ADD COLUMN IF NOT EXISTS otp_id TEXT;

ALTER TABLE turnkey_resources
  ADD COLUMN IF NOT EXISTS verified_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_turnkey_resources_app_verified_email
  ON turnkey_resources (app_id, verified_email)
  WHERE verified_email IS NOT NULL;
