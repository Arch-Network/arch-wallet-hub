-- Distinguish sub-org wallets created with WebAuthn authenticators
-- ("passkey") from those created with email-OTP-bootstrapped API
-- keys ("email"). The recovery flow needs this so the client can
-- branch between WebAuthn registration and IndexedDB-session
-- bootstrap when restoring a wallet on a fresh device.
--
-- Backfill rule: every existing sub-org row predates the
-- email-wallet feature, so they're all passkey wallets. Parent-org
-- rows (legacy custodial wallets) keep auth_method NULL; the
-- recovery route filters them out anyway and we intend to delete
-- that code path in P4.
ALTER TABLE turnkey_resources
  ADD COLUMN IF NOT EXISTS auth_method TEXT
  CHECK (auth_method IS NULL OR auth_method IN ('passkey', 'email'));

UPDATE turnkey_resources
SET auth_method = 'passkey'
WHERE auth_method IS NULL
  AND wallet_id IS NOT NULL
  AND organization_id <> (
    SELECT COALESCE(current_setting('app.root_org_id', true), '')
  );
-- Note: the COALESCE/current_setting trick keeps the backfill safe
-- when the GUC isn't set (e.g. local dev). In that case nothing is
-- backfilled to 'passkey' and the recovery route will treat NULL as
-- 'passkey' on read for legacy rows -- explicit and traceable.
