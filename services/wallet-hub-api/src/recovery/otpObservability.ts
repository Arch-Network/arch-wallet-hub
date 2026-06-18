import { createHash } from "node:crypto";
import type { RecoveryCandidate, RecoveryChallengeRow } from "../db/recovery.js";

const OTP_ID_FINGERPRINT_LENGTH = 12;

/**
 * Why a non-pending/expired challenge is being rejected. Shared by
 * /recovery/email/start and /recovery/email/verify so the rejection
 * reason logged + audited is consistent across both endpoints. The
 * "unknown" (challenge not found) case is handled by the routes
 * directly since it has no row to classify.
 */
export type RecoveryChallengeAvailability =
  | "available"
  | "not_pending"
  | "expired";

/**
 * Pure classification of a loaded challenge row: is it still usable,
 * already consumed/expired by status, or pending-but-past-TTL. Kept
 * free of DB/IO so it can be unit-tested and reused by both the start
 * and verify routes. `not_pending` takes precedence over `expired`,
 * matching the original guard order (a status check before the TTL
 * check) so reply semantics are preserved.
 */
export function classifyRecoveryChallengeAvailability(
  challenge: Pick<RecoveryChallengeRow, "status" | "expires_at">,
  nowMs = Date.now()
): RecoveryChallengeAvailability {
  if (challenge.status !== "pending") return "not_pending";
  const expiresMs = Date.parse(challenge.expires_at);
  if (Number.isFinite(expiresMs) && expiresMs < nowMs) return "expired";
  return "available";
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function fingerprintOtpId(otpId: string | null | undefined): string | null {
  if (!otpId) return null;
  return createHash("sha256")
    .update(otpId)
    .digest("hex")
    .slice(0, OTP_ID_FINGERPRINT_LENGTH);
}

export function getOtpStartCount(candidate: RecoveryCandidate): number {
  const count = candidate.otpStartCount;
  if (typeof count === "number" && Number.isFinite(count) && count > 0) {
    return Math.trunc(count);
  }
  return candidate.otpId ? 1 : 0;
}

export function getOtpAgeMs(
  candidate: RecoveryCandidate,
  nowMs = Date.now()
): number | null {
  const startedAtMs = parseIsoMs(candidate.otpStartedAt);
  if (startedAtMs === null) return null;
  return Math.max(0, nowMs - startedAtMs);
}

export function recordOtpStart(
  candidate: RecoveryCandidate,
  params: { otpId: string; startedAtIso?: string }
): RecoveryCandidate {
  return {
    ...candidate,
    otpId: params.otpId,
    otpStartCount: getOtpStartCount(candidate) + 1,
    otpStartedAt: params.startedAtIso ?? new Date().toISOString()
  };
}

export function recoveryOtpLogFields(
  candidate: RecoveryCandidate,
  nowMs = Date.now()
) {
  return {
    resourceId: candidate.resourceId,
    userId: candidate.userId,
    organizationId: candidate.organizationId,
    authMethod: candidate.authMethod,
    hasOtpId: Boolean(candidate.otpId),
    otpIdHash: fingerprintOtpId(candidate.otpId),
    otpStartCount: getOtpStartCount(candidate),
    otpAgeMs: getOtpAgeMs(candidate, nowMs)
  };
}

