ALTER TABLE turnkey_resources
  ADD COLUMN IF NOT EXISTS default_public_key_hex TEXT;
