-- HMAC-chained audit log for tamper-evidence.
--
-- Each new audit_logs row carries the HMAC-SHA256 of (prev_hash ||
-- canonical_row_payload) where the secret is sourced from
-- AUDIT_HMAC_SECRET (env). prev_hash is the previous row's `hash`
-- within the same app_id chain; the first row per app has
-- prev_hash = NULL (sentinel `genesis`).
--
-- Any insert / edit / delete in the middle of the chain breaks the
-- hash of every subsequent row, which the verifier (see audit/chain.ts)
-- detects. We don't try to defend against an adversary with the HMAC
-- secret AND write access -- they can rewrite the chain end-to-end.
-- This defends against accidental corruption, partial restores, and
-- adversaries who have DB write access but NOT the HMAC secret (the
-- typical compromise vector: DB exfil via SQL injection / leaked
-- credentials, where the secret stays in the process environment).
--
-- Existing rows (pre-migration) keep NULL hash columns. The chain
-- starts fresh from the first new insert per app. Backfilling would
-- be meaningless: the secret didn't exist when those rows were
-- written, so any "hash" we computed retroactively would be a lie.
-- Verifiers must skip rows where hash IS NULL.
--
-- Concurrency: insertAuditLog acquires a per-app advisory lock
-- (pg_advisory_xact_lock(hashtextextended(app_id::text, 0))) before
-- reading the chain tip, so concurrent inserts to the same app
-- serialize without blocking unrelated apps or any read traffic.

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS prev_hash TEXT,
  ADD COLUMN IF NOT EXISTS hash TEXT,
  -- Monotonic per-app sequence. Useful for the verifier to detect
  -- "row disappeared" between two intact chain segments (a hash-only
  -- check can miss this: a deleted row's predecessor still validates
  -- against an unchanged later row only if the deleter recomputed
  -- the chain, which requires the secret).
  ADD COLUMN IF NOT EXISTS chain_seq BIGINT;

-- Index for the per-app tip lookup the inserter does on every write.
-- Order by chain_seq DESC so `LIMIT 1` is an index-only seek.
CREATE INDEX IF NOT EXISTS idx_audit_logs_chain_tip
  ON audit_logs (app_id, chain_seq DESC)
  WHERE chain_seq IS NOT NULL;
