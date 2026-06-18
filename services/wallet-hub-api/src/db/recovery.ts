/**
 * DB helpers for the email-OTP recovery flow (migration 010).
 *
 * The `recovery_challenges` table stores one row per /recovery/email/init
 * call. Each row carries a JSON array of candidates -- (resourceId,
 * userId, organizationId, otpId, label, addressMasked, externalUserId,
 * walletId, defaultAddress, defaultPublicKeyHex) tuples -- so the
 * selected-wallet OTP start + verify steps can run without re-running
 * the lookup.
 */

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export interface RecoveryCandidate {
  /** Opaque token the client returns at verify; sha256(challengeId + resourceId). */
  candidateToken: string;
  resourceId: string;
  userId: string;
  externalUserId: string | null;
  organizationId: string;
  /** Sub-org root user id; recovered API key targets this user in
   *  CREATE_AUTHENTICATORS. */
  rootUserId: string | null;
  /** Turnkey OTP id returned by INIT_OTP_AUTH; populated after wallet selection. */
  otpId: string | null;
  /** Number of OTP emails started for this candidate within the challenge. */
  otpStartCount?: number;
  /** ISO timestamp for the latest OTP start; used only for diagnostics. */
  otpStartedAt?: string;
  walletLabel: string;
  addressMasked: string;
  walletId: string | null;
  defaultAddress: string | null;
  defaultPublicKeyHex: string | null;
  createdAt: string;
  /**
   * "passkey" if the sub-org has WebAuthn authenticators registered;
   * "email" if it was created with API keys only. Drives the
   * post-verify branch on the client (WebAuthn re-enrol vs
   * IndexedDB-session bootstrap).
   */
  authMethod: "passkey" | "email";
}

export interface RecoveryChallengeRow {
  id: string;
  app_id: string;
  email_hash: string;
  candidates: RecoveryCandidate[];
  status: "pending" | "consumed" | "expired" | "failed";
  attempts: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export function hashEmailForRateLimit(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return "***";
  if (local.length <= 2) return `${local[0] ?? "*"}***@${domain}`;
  return `${local[0]}${"*".repeat(Math.min(4, local.length - 2))}${local.slice(-1)}@${domain}`;
}

export function maskAddress(address: string | null): string {
  if (!address) return "";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export async function countRecentChallenges(
  client: PoolClient,
  params: { appId: string; emailHash: string; windowMs: number }
): Promise<number> {
  const res = await client.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count FROM recovery_challenges
      WHERE app_id = $1
        AND email_hash = $2
        AND created_at > NOW() - ($3::int * INTERVAL '1 millisecond')
    `,
    [params.appId, params.emailHash, params.windowMs]
  );
  return Number(res.rows[0]?.count ?? 0);
}

export async function insertRecoveryChallenge(
  client: PoolClient,
  params: {
    appId: string;
    emailHash: string;
    candidates: RecoveryCandidate[];
    ttlMs: number;
  }
): Promise<RecoveryChallengeRow> {
  const res = await client.query<RecoveryChallengeRow>(
    `
      INSERT INTO recovery_challenges (app_id, email_hash, candidates, status, expires_at)
      VALUES ($1, $2, $3::jsonb, 'pending', NOW() + ($4::int * INTERVAL '1 millisecond'))
      RETURNING *
    `,
    [params.appId, params.emailHash, JSON.stringify(params.candidates), params.ttlMs]
  );
  return res.rows[0]!;
}

export async function getRecoveryChallenge(
  client: PoolClient,
  params: { appId: string; id: string }
): Promise<RecoveryChallengeRow | null> {
  const res = await client.query<RecoveryChallengeRow>(
    `SELECT * FROM recovery_challenges WHERE id = $1 AND app_id = $2`,
    [params.id, params.appId]
  );
  return res.rows[0] ?? null;
}

export async function incrementRecoveryAttempts(
  client: PoolClient,
  params: { id: string }
): Promise<RecoveryChallengeRow | null> {
  const res = await client.query<RecoveryChallengeRow>(
    `
      UPDATE recovery_challenges
      SET attempts = attempts + 1
      WHERE id = $1
      RETURNING *
    `,
    [params.id]
  );
  return res.rows[0] ?? null;
}

/**
 * Atomically increment the attempt counter only if the challenge is
 * still pending and under the cap. Returns the updated row when the
 * attempt was counted, or null when the challenge is gone, already
 * consumed/expired, or the cap was reached. Doing the check and the
 * increment in a single UPDATE closes the race where two concurrent
 * verifies both read `attempts` below the cap and both proceed.
 */
export async function incrementRecoveryAttemptIfUnderCap(
  client: PoolClient,
  params: { id: string; appId: string; maxAttempts: number }
): Promise<RecoveryChallengeRow | null> {
  const res = await client.query<RecoveryChallengeRow>(
    `
      UPDATE recovery_challenges
      SET attempts = attempts + 1
      WHERE id = $1
        AND app_id = $2
        AND status = 'pending'
        AND attempts < $3
      RETURNING *
    `,
    [params.id, params.appId, params.maxAttempts]
  );
  return res.rows[0] ?? null;
}

export async function updateRecoveryChallengeCandidates(
  client: PoolClient,
  params: { id: string; candidates: RecoveryCandidate[] }
): Promise<RecoveryChallengeRow | null> {
  const res = await client.query<RecoveryChallengeRow>(
    `
      UPDATE recovery_challenges
      SET candidates = $2::jsonb
      WHERE id = $1
      RETURNING *
    `,
    [params.id, JSON.stringify(params.candidates)]
  );
  return res.rows[0] ?? null;
}

export async function markRecoveryChallengeStatus(
  client: PoolClient,
  params: { id: string; status: "consumed" | "expired" | "failed" }
): Promise<void> {
  await client.query(
    `
      UPDATE recovery_challenges
      SET status = $2,
          consumed_at = CASE WHEN $2 = 'consumed' THEN NOW() ELSE consumed_at END
      WHERE id = $1
    `,
    [params.id, params.status]
  );
}

export function computeCandidateToken(challengeId: string, resourceId: string): string {
  return createHash("sha256")
    .update(`${challengeId}:${resourceId}`)
    .digest("hex");
}
