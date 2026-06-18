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

export interface ResendThrottleLimits {
  /** Reject a resend whose previous OTP is younger than this. */
  cooldownMs: number;
  /** Max OTP emails (initial + resends) allowed per challenge candidate. */
  maxSends: number;
}

export type ResendThrottleDecision =
  | { throttled: false }
  | { throttled: true; reason: "cooldown" | "max_sends" };

/**
 * Decide whether a resend OTP request should be throttled. Pure (no
 * DB/IO) so it can be unit-tested in isolation; the route owns the
 * limits and the side effects.
 *
 * `previousOtpStartCount` is how many OTPs have already been sent for
 * this candidate. A resend would push it one higher, so once it has
 * reached `maxSends` we refuse rather than mint another OTP -- this
 * stops a user from using resend to reset verify attempts indefinitely.
 *
 * `previousOtpAgeMs` is the age of the most recent OTP (null when no
 * start timestamp exists). A resend inside the cooldown window is
 * refused to cut down on overlapping in-flight OTPs, the root cause of
 * stale-code verification failures.
 *
 * The send cap takes precedence over the cooldown so the more permanent
 * "you're out of sends" signal wins when both apply.
 */
export function shouldThrottleResend(
  previousOtpAgeMs: number | null,
  previousOtpStartCount: number,
  limits: ResendThrottleLimits
): ResendThrottleDecision {
  if (previousOtpStartCount >= limits.maxSends) {
    return { throttled: true, reason: "max_sends" };
  }
  if (previousOtpAgeMs !== null && previousOtpAgeMs < limits.cooldownMs) {
    return { throttled: true, reason: "cooldown" };
  }
  return { throttled: false };
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

