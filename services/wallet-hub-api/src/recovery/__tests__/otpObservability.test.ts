import { describe, expect, it } from "vitest";
import type { RecoveryCandidate, RecoveryChallengeRow } from "../../db/recovery.js";
import {
  classifyRecoveryChallengeAvailability,
  fingerprintOtpId,
  getOtpAgeMs,
  getOtpStartCount,
  recordOtpStart,
  recoveryOtpLogFields
} from "../otpObservability.js";

function candidate(overrides: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return {
    candidateToken: "candidate-token",
    resourceId: "resource-1",
    userId: "user-1",
    externalUserId: "external-user-1",
    organizationId: "org-1",
    rootUserId: "root-user-1",
    otpId: null,
    walletLabel: "Wallet 1234",
    addressMasked: "bc1p...1234",
    walletId: "wallet-1",
    defaultAddress: "bc1ptest",
    defaultPublicKeyHex: "02abcdef",
    createdAt: "2026-06-18T00:00:00.000Z",
    authMethod: "email",
    ...overrides
  };
}

describe("recovery OTP observability", () => {
  it("treats legacy candidates with an otpId as one started OTP", () => {
    expect(getOtpStartCount(candidate({ otpId: "otp-old" }))).toBe(1);
  });

  it("increments start metadata without exposing raw otp ids", () => {
    const started = recordOtpStart(candidate({ otpId: "otp-old" }), {
      otpId: "otp-new",
      startedAtIso: "2026-06-18T11:08:00.000Z"
    });

    expect(started.otpId).toBe("otp-new");
    expect(started.otpStartCount).toBe(2);
    expect(started.otpStartedAt).toBe("2026-06-18T11:08:00.000Z");

    const fields = recoveryOtpLogFields(
      started,
      Date.parse("2026-06-18T11:09:00.000Z")
    );
    expect(fields.otpIdHash).toBe(fingerprintOtpId("otp-new"));
    expect(fields.otpIdHash).not.toBe("otp-new");
    expect(fields.otpAgeMs).toBe(60_000);
  });

  it("returns null age when no start timestamp exists", () => {
    expect(getOtpAgeMs(candidate())).toBeNull();
  });
});

describe("classifyRecoveryChallengeAvailability", () => {
  const nowMs = Date.parse("2026-06-18T12:00:00.000Z");

  function challenge(
    overrides: Partial<Pick<RecoveryChallengeRow, "status" | "expires_at">> = {}
  ): Pick<RecoveryChallengeRow, "status" | "expires_at"> {
    return {
      status: "pending",
      expires_at: "2026-06-18T12:10:00.000Z",
      ...overrides
    };
  }

  it("treats a pending, unexpired challenge as available", () => {
    expect(classifyRecoveryChallengeAvailability(challenge(), nowMs)).toBe(
      "available"
    );
  });

  it("reports non-pending status before checking expiry", () => {
    // Past TTL but already consumed -> not_pending wins (matches the
    // original status-before-TTL guard order).
    expect(
      classifyRecoveryChallengeAvailability(
        challenge({ status: "consumed", expires_at: "2026-06-18T11:00:00.000Z" }),
        nowMs
      )
    ).toBe("not_pending");
  });

  it("reports expired for a pending challenge past its TTL", () => {
    expect(
      classifyRecoveryChallengeAvailability(
        challenge({ expires_at: "2026-06-18T11:59:59.000Z" }),
        nowMs
      )
    ).toBe("expired");
  });

  it("treats an unparseable expiry as available rather than expired", () => {
    expect(
      classifyRecoveryChallengeAvailability(
        challenge({ expires_at: "not-a-date" }),
        nowMs
      )
    ).toBe("available");
  });
});

