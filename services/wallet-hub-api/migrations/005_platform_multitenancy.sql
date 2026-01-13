-- Multi-tenant platform layer: apps + API keys + app scoping for existing tables.

CREATE TABLE IF NOT EXISTS apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at TIMESTAMPTZ
);

-- Legacy/default app for pre-multitenancy rows (safe migration in dev environments).
INSERT INTO apps (id, name)
VALUES ('00000000-0000-0000-0000-000000000000', 'legacy')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_app_api_keys_app_id ON app_api_keys(app_id);

-- Scope core tables by app_id (default legacy for existing rows).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS app_id UUID REFERENCES apps(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000000',
  ADD COLUMN IF NOT EXISTS external_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_users_app_id ON users(app_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_app_external_user
  ON users(app_id, external_user_id)
  WHERE external_user_id IS NOT NULL;

ALTER TABLE turnkey_resources
  ADD COLUMN IF NOT EXISTS app_id UUID REFERENCES apps(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000000';
CREATE INDEX IF NOT EXISTS idx_turnkey_resources_app_id ON turnkey_resources(app_id);

ALTER TABLE wallet_link_challenges
  ADD COLUMN IF NOT EXISTS app_id UUID REFERENCES apps(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000000';
CREATE INDEX IF NOT EXISTS idx_wallet_link_challenges_app_id ON wallet_link_challenges(app_id);

ALTER TABLE linked_wallets
  ADD COLUMN IF NOT EXISTS app_id UUID REFERENCES apps(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000000';
CREATE INDEX IF NOT EXISTS idx_linked_wallets_app_id ON linked_wallets(app_id);

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS app_id UUID REFERENCES apps(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000000';
CREATE INDEX IF NOT EXISTS idx_audit_logs_app_id ON audit_logs(app_id);

ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS app_id UUID REFERENCES apps(id) ON DELETE CASCADE DEFAULT '00000000-0000-0000-0000-000000000000';

-- Idempotency uniqueness must be per-app.
ALTER TABLE idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_idempotency_key_route_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_idempotency_keys_app_route_key
  ON idempotency_keys(app_id, idempotency_key, route);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_app_id ON idempotency_keys(app_id);
