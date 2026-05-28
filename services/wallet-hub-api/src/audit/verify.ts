/**
 * DB-aware audit-chain verifier.
 *
 * Fetches all chained rows for an app (ordered by chain_seq ASC,
 * skipping pre-migration NULL-chain rows), reconstructs the
 * canonical form, and delegates to the pure `verifyChain` helper.
 *
 * Intended consumers:
 *   - A scheduled job (cron / Eventbridge) that runs nightly and
 *     pages a human on a non-`ok` result.
 *   - An admin-only HTTP route for ad-hoc forensics (not added
 *     in this PR -- the route would need careful auth scoping
 *     because dumping the chain is essentially a full audit
 *     export).
 *   - Unit / integration tests once a Postgres test harness is
 *     wired into wallet-hub-api.
 *
 * Cost note: this is a full-table scan of the per-app chain. For
 * a busy app that produces 100k+ audit rows/day we'd want a
 * checkpoint mechanism (store the latest verified chain_seq +
 * its hash off-DB, then only re-verify the suffix). Out of scope
 * for v1; the predicate "audit_logs row count under 10M" covers
 * us comfortably for the foreseeable future.
 */

import type { PoolClient } from "pg";
import {
  canonicalPayloadHash,
  verifyChain,
  type CanonicalRow,
  type VerifyChainResult,
} from "./chain.js";

interface AuditRowFromDb {
  id: string;
  created_at: Date;
  app_id: string;
  request_id: string | null;
  user_id: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  turnkey_activity_id: string | null;
  turnkey_request_id: string | null;
  payload_json: unknown | null;
  outcome: "requested" | "succeeded" | "failed";
  prev_hash: string | null;
  hash: string | null;
  chain_seq: string | number | null;
}

/**
 * Verify every chained row in the per-app audit log. Pre-migration
 * NULL-chain rows are skipped at the SQL level so they don't break
 * verification of the post-migration suffix.
 */
export async function verifyAuditChainForApp(
  client: PoolClient,
  appId: string,
  secret: string,
): Promise<VerifyChainResult & { rowsVerified: number }> {
  const res = await client.query<AuditRowFromDb>(
    `SELECT *
       FROM audit_logs
      WHERE app_id = $1 AND chain_seq IS NOT NULL
      ORDER BY chain_seq ASC`,
    [appId],
  );

  const rows = res.rows.map((r) => {
    const canonical: CanonicalRow = {
      id: r.id,
      // Postgres TIMESTAMPTZ comes back as Date; we re-format to ISO
      // for hash-input parity with the inserter (which used
      // `new Date().toISOString()` at insert time). The Date round-
      // trip preserves the original ms-precision instant, so the
      // ISO strings match byte-for-byte.
      createdAt: r.created_at.toISOString(),
      appId: r.app_id,
      requestId: r.request_id,
      userId: r.user_id,
      eventType: r.event_type,
      entityType: r.entity_type,
      entityId: r.entity_id,
      turnkeyActivityId: r.turnkey_activity_id,
      turnkeyRequestId: r.turnkey_request_id,
      payloadHashHex: canonicalPayloadHash(r.payload_json ?? null),
      outcome: r.outcome,
    };
    return {
      row: canonical,
      storedPrevHash: r.prev_hash,
      storedHash: r.hash,
      chainSeq:
        r.chain_seq === null
          ? null
          : typeof r.chain_seq === "string"
            ? Number(r.chain_seq)
            : r.chain_seq,
    };
  });

  const result = verifyChain(secret, rows);
  return { ...result, rowsVerified: rows.length };
}
