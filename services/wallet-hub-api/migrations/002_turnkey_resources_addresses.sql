ALTER TABLE turnkey_resources
  ADD COLUMN IF NOT EXISTS default_address TEXT,
  ADD COLUMN IF NOT EXISTS default_address_format TEXT,
  ADD COLUMN IF NOT EXISTS default_derivation_path TEXT;

