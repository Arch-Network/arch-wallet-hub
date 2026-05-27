-- Per-user session tokens + Turnkey-signed challenge handshake.
--
-- Why: the Hub today trusts a caller-supplied `externalUserId` from
-- every request body. Any caller with the shared app `x-api-key`
-- can impersonate any user of the same app (audit findings
-- X1 / Backend M7 / SDK C1). The fix is a bearer token minted in
-- exchange for proof of control over the user's Turnkey resource
-- (signing a server-issued challenge with the resource's default
-- Taproot key, verified via schnorr.verify against the stored
-- `default_public_key_hex`).
--
-- Two tables:
--   * auth_challenges: short-lived (~5 min) random-nonce rows. A
--     challenge can be consumed exactly once.
--   * auth_sessions:   longer-lived (~24 h default) bearer rows.
--     Only the sha256 hash of the token is stored; the plaintext
--     is returned exactly once at mint time.
--
-- Both tables key on (app_id, user_id) so a leaked single-user
-- token can never operate cross-tenant even within the same app.

CREATE TABLE IF NOT EXISTS auth_challenges (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The hex payload the client signs. 32 bytes (sha256 of the
  -- human-readable message), expressed as 64 lowercase hex chars
  -- so HASH_FUNCTION_NO_OP signers can sign it directly.
  payload_hex  TEXT NOT NULL,
  -- The full human-readable message, kept for audit + client
  -- display. Not part of the signature surface; the client signs
  -- payload_hex.
  message      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS auth_challenges_user_idx
  ON auth_challenges (app_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- sha256(token) hex. The plaintext token is returned exactly
  -- once at mint time and never persisted.
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
  ON auth_sessions (app_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_sessions_token_hash_idx
  ON auth_sessions (token_hash) WHERE revoked_at IS NULL;
