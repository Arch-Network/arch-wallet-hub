/**
 * HMAC-chained audit log: pure helpers.
 *
 * Each `audit_logs` row stores:
 *   hash      = HMAC-SHA256(secret, prev_hash_or_genesis || ":" || canonicalRow(row))
 *   prev_hash = the previous row's `hash` within the same `app_id` chain
 *   chain_seq = monotonic per-app sequence number (starts at 1)
 *
 * Tamper-evidence properties:
 *   - An attacker with DB write access but WITHOUT the secret cannot
 *     produce a valid `hash` for an edited / inserted row. The
 *     verifier (verifyChain in this module) will reject the chain.
 *   - Deleting a row breaks the chain: row N+1's prev_hash points
 *     at row N's hash, which no longer exists.
 *   - Reordering rows breaks chain_seq monotonicity AND prev_hash.
 *
 * What this does NOT defend against:
 *   - Attacker who has both DB write access AND the HMAC secret can
 *     forge a fully consistent chain. The threat model is "DB
 *     leaked / writable; process env not". Typical real-world cases:
 *     SQL injection, leaked DB credentials, weekend DBA-with-curl.
 *   - Append-only forks at the tip from a privileged inserter
 *     (the chain still validates because the most-recent legitimate
 *     row's hash is unchanged). Detecting that requires an
 *     external pinning service that periodically records the tip
 *     hash off-DB; we don't ship one here.
 *
 * Pure-function discipline:
 *   - This file does NO database I/O. The functions below take
 *     in-memory rows and produce hashes. The DB-aware insert path
 *     lives in queries.ts and uses these helpers; the verifier
 *     fetches rows separately and calls verifyChain to validate.
 *   - All inputs/outputs are strings or plain objects so the
 *     helpers are trivially unit-testable without a Postgres
 *     instance.
 */

import { createHmac } from "node:crypto";

/**
 * The sentinel prev_hash for the first row in a chain. We use a
 * fixed literal rather than NULL so the HMAC input is always a
 * well-defined string and the verifier doesn't need a NULL-handling
 * special case in the hot loop.
 *
 * The literal "genesis" is fine to be public knowledge: it's the
 * starting `prev_hash`, not the secret. Forgery requires the HMAC
 * key, not knowledge of the genesis sentinel.
 */
export const GENESIS_PREV_HASH = "genesis";

/**
 * Canonical row shape -- exactly the fields that participate in
 * the HMAC. Everything that doesn't is excluded (created_at is
 * included because we want timestamp tampering to break the chain;
 * `id`, the surrogate UUID PK, is included because reusing an
 * id is a clear corruption signal).
 *
 * payload_json is hashed in two steps: first JSON.stringify with
 * deterministic key ordering (sorted), then SHA256. The chain
 * input is the SHA256, not the raw JSON. This keeps the canonical
 * row a fixed length regardless of payload size and means a
 * payload edit is detected just like any other field edit.
 */
export interface CanonicalRow {
  id: string;
  /** ISO-8601 timestamp string -- Postgres TIMESTAMPTZ formatted by toISOString(). */
  createdAt: string;
  appId: string;
  /** null is hashed as the literal "null". */
  requestId: string | null;
  userId: string | null;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  turnkeyActivityId: string | null;
  turnkeyRequestId: string | null;
  /** Already canonicalized + SHA256'd. Pass through canonicalPayloadHash(). */
  payloadHashHex: string;
  outcome: "requested" | "succeeded" | "failed";
}

function nullableField(value: string | null): string {
  return value === null ? "\x00null" : value;
}

/**
 * Pipe-delimited single-line concatenation. We use `\x00` (NUL)
 * as the field separator because it cannot appear inside any
 * user-supplied string -- Postgres TEXT columns reject NULs at
 * insert time, so no payload field can smuggle a separator.
 *
 * Without a separator the chain would be vulnerable to a
 * preimage-style attack where "foo|bar" and "fo|obar" hash to the
 * same input. Using NUL prevents that.
 */
function serializeCanonicalRow(row: CanonicalRow): string {
  return [
    row.id,
    row.createdAt,
    row.appId,
    nullableField(row.requestId),
    nullableField(row.userId),
    row.eventType,
    nullableField(row.entityType),
    nullableField(row.entityId),
    nullableField(row.turnkeyActivityId),
    nullableField(row.turnkeyRequestId),
    row.payloadHashHex,
    row.outcome,
  ].join("\x00");
}

/**
 * Compute the row's chain hash. Output is lowercase hex, 64 chars.
 */
export function computeRowHash(
  secret: string,
  prevHash: string | null,
  row: CanonicalRow,
): string {
  const prev = prevHash ?? GENESIS_PREV_HASH;
  const hmac = createHmac("sha256", secret);
  hmac.update(prev);
  hmac.update("\x00");
  hmac.update(serializeCanonicalRow(row));
  return hmac.digest("hex");
}

/**
 * Deterministic JSON serialization for the payload field. Sorts
 * object keys recursively so two semantically-equal payloads hash
 * identically regardless of insertion order. Pure helper -- arrays
 * keep their natural order (changing array order IS a meaningful
 * change).
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJsonStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJsonStringify(obj[k]))
      .join(",") +
    "}"
  );
}

/**
 * Hash a payload to its canonical chain-input form. Returns
 * lowercase hex, 64 chars. NULL payload hashes as the literal
 * string "null" -- distinct from `{}` and `""`.
 */
export function canonicalPayloadHash(payload: unknown): string {
  const text = canonicalJsonStringify(payload);
  return createHmac("sha256", "").update(text).digest("hex");
}

export interface VerifyChainResult {
  ok: boolean;
  /**
   * Index (0-based, in input order) of the first row that fails
   * validation. `null` when the chain validates end-to-end.
   */
  failedAt: number | null;
  reason:
    | "chain-empty"
    | "ok"
    | "prev-hash-mismatch"
    | "hash-mismatch"
    | "chain-seq-non-monotonic"
    | "missing-hash";
}

/**
 * Validate that an ordered run of rows (oldest-first, all from the
 * same app) is a consistent chain. The caller is responsible for
 * fetching rows in chain_seq ASC order; this function does NOT
 * re-sort.
 */
export function verifyChain(
  secret: string,
  rows: Array<{
    row: CanonicalRow;
    storedPrevHash: string | null;
    storedHash: string | null;
    chainSeq: number | null;
  }>,
): VerifyChainResult {
  if (rows.length === 0) {
    return { ok: true, failedAt: null, reason: "chain-empty" };
  }
  let expectedPrev: string | null = null;
  let expectedSeq = 1;
  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i]!;
    if (entry.storedHash === null || entry.chainSeq === null) {
      return { ok: false, failedAt: i, reason: "missing-hash" };
    }
    if (entry.chainSeq !== expectedSeq) {
      return { ok: false, failedAt: i, reason: "chain-seq-non-monotonic" };
    }
    const expectedPrevForRow = expectedPrev;
    if ((entry.storedPrevHash ?? null) !== expectedPrevForRow) {
      return { ok: false, failedAt: i, reason: "prev-hash-mismatch" };
    }
    const recomputed = computeRowHash(secret, expectedPrevForRow, entry.row);
    if (recomputed !== entry.storedHash) {
      return { ok: false, failedAt: i, reason: "hash-mismatch" };
    }
    expectedPrev = entry.storedHash;
    expectedSeq += 1;
  }
  return { ok: true, failedAt: null, reason: "ok" };
}

/**
 * Resolve the audit secret. Throws in production if AUDIT_HMAC_SECRET
 * is missing (env.ts already enforces this -- this is belt-and-
 * suspenders so a misconfigured embedding can't silently fall through
 * to the dev secret).
 *
 * In dev/test, returns a hardcoded sentinel and logs a warning
 * the FIRST time it's used (caller responsibility -- this module
 * doesn't carry process state). The sentinel value is intentionally
 * obvious so leaked-secret detection in logs/dumps spots it.
 */
export const DEV_AUDIT_SECRET_SENTINEL =
  "dev-only-audit-secret-do-not-use-in-production";

export function resolveAuditSecret(
  env: { AUDIT_HMAC_SECRET?: string; NODE_ENV: "development" | "test" | "production" },
): string {
  if (env.AUDIT_HMAC_SECRET) return env.AUDIT_HMAC_SECRET;
  if (env.NODE_ENV === "production") {
    throw new Error("AUDIT_HMAC_SECRET missing in production environment");
  }
  return DEV_AUDIT_SECRET_SENTINEL;
}
