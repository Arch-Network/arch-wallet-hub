-- Bind each Turnkey session challenge to exactly one resource, and record
-- which resource keys the Hub has actually confirmed with Turnkey.
--
-- Why: /auth/session used to accept a signature from ANY
-- `default_public_key_hex` on the challenge user's resources, and
-- /turnkey/passkey-wallets/import stored whatever key the caller sent. A
-- caller could plant their own key on a user and mint that user's session.
--
--   * auth_challenges.resource_id: the resource whose key must sign.
--     NULL for external (BIP-322) challenges and for Turnkey challenges
--     issued before this migration (those 5-minute rows fail closed).
--   * turnkey_resources.key_verified_at: set when the key came from
--     Hub-driven sub-org creation or was matched against Turnkey's wallet
--     accounts. NULL keys can't mint sessions until re-verified.

ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS resource_id UUID REFERENCES turnkey_resources(id) ON DELETE CASCADE;

ALTER TABLE turnkey_resources
  ADD COLUMN IF NOT EXISTS key_verified_at TIMESTAMPTZ;

-- Hub-created rows carry the wallet_id Turnkey returned at creation; the
-- import route never stored one, so imported rows stay unverified.
UPDATE turnkey_resources
   SET key_verified_at = created_at
 WHERE wallet_id IS NOT NULL
   AND key_verified_at IS NULL;
