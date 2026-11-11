import { describe, expect, it, vi } from "vitest";
import { TurnkeyService } from "../client.js";

/**
 * The sign-in routes mock the Turnkey service away, so these pin what it
 * sends: the V2/V3 OTP activity types, the parent org for INIT/VERIFY and
 * the user's sub-org for OTP_LOGIN, and the result fields read back.
 */

function service(client: Record<string, unknown>) {
  const svc = new TurnkeyService({
    baseUrl: "https://api.turnkey.com",
    organizationId: "parent-org",
    apiPublicKey: "02" + "11".repeat(32),
    apiPrivateKey: "22".repeat(32)
  });
  (svc as any).client = client;
  return svc;
}

const completed = (result: object) => ({
  activity: { id: "act-1", status: "ACTIVITY_STATUS_COMPLETED", organizationId: "org", result }
});

describe("Turnkey OTP sign-in activities", () => {
  it("sends INIT_OTP_V3 to the parent org for a six-digit email code", async () => {
    const initOtp = vi.fn(async (_body: unknown) =>
      completed({ initOtpResultV2: { otpId: "otp-1", otpEncryptionTargetBundle: "target" } })
    );

    const res = await service({ initOtp }).initOtp({
      contact: "a@example.com",
      userIdentifier: "uid",
      appName: "Arch Wallet",
      expirationSeconds: "600"
    });

    expect(res).toEqual({ otpId: "otp-1", otpEncryptionTargetBundle: "target", activityId: "act-1" });
    expect(initOtp.mock.calls[0]![0]).toMatchObject({
      type: "ACTIVITY_TYPE_INIT_OTP_V3",
      organizationId: "parent-org",
      parameters: {
        otpType: "OTP_TYPE_EMAIL",
        otpLength: 6,
        alphanumeric: false,
        contact: "a@example.com",
        appName: "Arch Wallet",
        expirationSeconds: "600"
      }
    });
  });

  it("sends VERIFY_OTP_V2 to the parent org and returns the verification token", async () => {
    const verifyOtp = vi.fn(async (_body: unknown) => completed({ verifyOtpResult: { verificationToken: "jwt" } }));

    const res = await service({ verifyOtp }).verifyOtp({
      otpId: "otp-1",
      encryptedOtpBundle: "bundle",
      expirationSeconds: "300"
    });

    expect(res).toEqual({ verificationToken: "jwt", activityId: "act-1" });
    expect(verifyOtp.mock.calls[0]![0]).toMatchObject({
      type: "ACTIVITY_TYPE_VERIFY_OTP_V2",
      organizationId: "parent-org",
      parameters: { otpId: "otp-1", encryptedOtpBundle: "bundle", expirationSeconds: "300" }
    });
  });

  it("sends OTP_LOGIN_V2 to the user's sub-org with the client's signature", async () => {
    const otpLogin = vi.fn(async (_body: unknown) => completed({ otpLoginResult: { session: "session-jwt" } }));
    const clientSignature = {
      scheme: "CLIENT_SIGNATURE_SCHEME_API_P256",
      publicKey: "02ee",
      message: "{}",
      signature: "ab"
    };

    const res = await service({ otpLogin }).otpLogin({
      organizationId: "sub-org",
      verificationToken: "jwt",
      publicKey: "02ee",
      clientSignature,
      expirationSeconds: "3600"
    });

    expect(res).toEqual({ session: "session-jwt", activityId: "act-1" });
    expect(otpLogin.mock.calls[0]![0]).toMatchObject({
      type: "ACTIVITY_TYPE_OTP_LOGIN_V2",
      organizationId: "sub-org",
      parameters: { verificationToken: "jwt", publicKey: "02ee", clientSignature, expirationSeconds: "3600" }
    });
  });

  it("throws when Turnkey fails the verify activity", async () => {
    const verifyOtp = vi.fn(async () => ({
      activity: { id: "act-1", status: "ACTIVITY_STATUS_FAILED", organizationId: "org", result: {} }
    }));

    await expect(
      service({ verifyOtp }).verifyOtp({ otpId: "otp-1", encryptedOtpBundle: "bundle", expirationSeconds: "300" })
    ).rejects.toThrow(/did not complete/);
  });
});
