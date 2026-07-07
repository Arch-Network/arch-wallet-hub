-- Canonical Arch identity fix (Unisat/external-wallet derivation bug).
--
-- Background: wallet linking previously derived the Arch account identity by
-- decoding the taproot ADDRESS, which yields the BIP-341 TWEAKED output key.
-- The canonical Arch identity is the UNTWEAKED internal x-only pubkey (what
-- the Arch node verifies signatures against). The tweak is one-way, so the
-- canonical key CANNOT be backfilled in SQL from existing rows; it is
-- re-derived in application code on the next link of each affected wallet
-- (the client now supplies the wallet's public key).
--
-- This migration only adds columns; it never mutates or deletes existing
-- mappings. Re-running is a no-op (IF NOT EXISTS), and the migration runner
-- additionally records it in schema_migrations.

-- Wallet public key captured at challenge time so /wallet-links/verify can
-- derive the canonical identity after the signature check.
ALTER TABLE wallet_link_challenges
  ADD COLUMN IF NOT EXISTS public_key_hex TEXT;

-- Wallet public key that produced arch_account_address (NULL for legacy rows
-- registered from the address-decoded/tweaked key).
ALTER TABLE linked_wallets
  ADD COLUMN IF NOT EXISTS public_key_hex TEXT;

-- Audit trail: when a re-link migrates a row from the tweaked identity to the
-- canonical one, the previous (tweaked) arch account address is preserved
-- here rather than destroyed. Only ever set once (first migration wins).
ALTER TABLE linked_wallets
  ADD COLUMN IF NOT EXISTS legacy_arch_account_address TEXT;
