import { createHash } from "node:crypto";
import type { RecoveryCandidate } from "../db/recovery.js";

const OTP_ID_FINGERPRINT_LENGTH = 12;

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

