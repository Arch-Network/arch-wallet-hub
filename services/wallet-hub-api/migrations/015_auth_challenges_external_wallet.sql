-- External-wallet (BIP-322) session minting.
--
-- The session handshake in migration 013 only supported Turnkey-custodied
-- resources: the client signs the challenge's `payload_hex` with the
-- resource's default Taproot key, verified via schnorr.verify. External /
-- linked wallets (Xverse, UniSat, ...) have no Turnkey key on the device
-- and instead prove control with a BIP-322 signature over the challenge's
-- human-readable `message` -- exactly the scheme already used by the
-- wallet-linking flow (migration 003 / routes/walletLinking.ts).
--
-- To mint a session for such a wallet we need to bind the challenge to the
-- specific linked-wallet (provider, address) it targets so the mint can
-- (a) verify the BIP-322 signature against that address and (b) confirm a
-- `linked_wallets` row for the challenge's user still owns it.
--
-- Both columns are NULLABLE: the Turnkey path (createChallenge) leaves them
-- NULL, the external path (createExternalChallenge) populates them. A
-- challenge with a non-NULL address is an external challenge.

ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS wallet_provider TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT;
