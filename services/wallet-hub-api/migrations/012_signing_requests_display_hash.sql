-- Store the canonical sha256-hex digest of the `display_json` payload
-- next to the row that owns it.
--
-- Why: the wallet UI verifies what the user sees against what the
-- server intends them to sign. Until now `displayHash` lived only in
-- the SDK type definitions; the server never produced one, which
-- meant `TransactionPreview` could not actually detect display
-- tampering. After this migration, every newly-created signing
-- request gets a hash at insert time and the value flows through
-- both create + get responses.
--
-- Nullable for backward compatibility with rows created before the
-- column existed. The GET handler computes the hash on-the-fly when
-- `display_hash` is NULL so the wire contract is uniform across
-- legacy and post-migration rows. A future migration may backfill
-- and add NOT NULL once the long tail of pending rows has drained.

ALTER TABLE signing_requests
  ADD COLUMN IF NOT EXISTS display_hash TEXT;
