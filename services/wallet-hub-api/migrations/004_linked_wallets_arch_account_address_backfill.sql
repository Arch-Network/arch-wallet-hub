-- Add arch_account_address for derived Arch account mapping.
-- We keep it nullable for now because backfilling from bech32m requires application-level decoding.

ALTER TABLE linked_wallets
  ADD COLUMN IF NOT EXISTS arch_account_address TEXT;

-- No backfill in SQL because mapping requires bech32m decode; this is handled in application code.
