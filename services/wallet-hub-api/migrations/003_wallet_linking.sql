CREATE TABLE IF NOT EXISTS wallet_link_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  wallet_provider TEXT NOT NULL,
  address TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_link_challenges_user_id ON wallet_link_challenges(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_link_challenges_address ON wallet_link_challenges(address);

CREATE TABLE IF NOT EXISTS linked_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  wallet_provider TEXT NOT NULL,
  address TEXT NOT NULL,
  network TEXT NOT NULL, -- bitcoin mainnet/testnet/signet/regtest; used for indexing
  verification_scheme TEXT NOT NULL, -- bip322, bip137, wallet_specific
  signature TEXT NOT NULL, -- base64 or hex as provided
  message TEXT NOT NULL, -- the signed challenge (stored for audit)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, wallet_provider, address)
);

CREATE INDEX IF NOT EXISTS idx_linked_wallets_user_id ON linked_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_linked_wallets_address ON linked_wallets(address);

