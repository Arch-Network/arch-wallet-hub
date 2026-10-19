import { describe, expect, it } from "vitest";
import { getEnv } from "../env.js";

/**
 * REVIEW_LOGIN_ENABLED must fail fast when the dummy-wallet config is
 * incomplete, so a half-configured review login can't 500 the recovery
 * endpoints for the test email.
 */

const baseEnv = {
  TURNKEY_ORGANIZATION_ID: "root-org",
  TURNKEY_API_PUBLIC_KEY: "pub",
  TURNKEY_API_PRIVATE_KEY: "priv",
  DATABASE_URL: "postgres://u:p@localhost:5432/db"
} as NodeJS.ProcessEnv;

const validReviewEnv = {
  ...baseEnv,
  REVIEW_LOGIN_ENABLED: "true",
  REVIEW_LOGIN_EMAIL: "play-review@arch.network",
  REVIEW_LOGIN_OTP_CODE: "424242",
  REVIEW_LOGIN_ORGANIZATION_ID: "sub-org-review",
  REVIEW_LOGIN_ROOT_USER_ID: "root-user-review",
  REVIEW_LOGIN_WALLET_ID: "wallet-review",
  REVIEW_LOGIN_DEFAULT_ADDRESS: "bc1preview",
  REVIEW_LOGIN_API_PRIVATE_KEY_HEX: "ab".repeat(32)
} as NodeJS.ProcessEnv;

describe("review-login env validation", () => {
  it("defaults to disabled", () => {
    const env = getEnv({ ...baseEnv });
    expect(env.REVIEW_LOGIN_ENABLED).toBe(false);
  });

  it("accepts a fully-specified review config", () => {
    const env = getEnv({ ...validReviewEnv });
    expect(env.REVIEW_LOGIN_ENABLED).toBe(true);
    expect(env.REVIEW_LOGIN_EMAIL).toBe("play-review@arch.network");
  });

  it("rejects enabling the feature without the required fields", () => {
    expect(() =>
      getEnv({ ...baseEnv, REVIEW_LOGIN_ENABLED: "true" })
    ).toThrow(/REVIEW_LOGIN_ENABLED=true requires/);
  });

  it("rejects a non-hex / wrong-length review private key", () => {
    expect(() =>
      getEnv({ ...validReviewEnv, REVIEW_LOGIN_API_PRIVATE_KEY_HEX: "xyz" })
    ).toThrow(/REVIEW_LOGIN_API_PRIVATE_KEY_HEX must be 64 hex chars/);
  });

  it("rejects an OTP code shorter than 4 characters", () => {
    expect(() =>
      getEnv({ ...validReviewEnv, REVIEW_LOGIN_OTP_CODE: "12" })
    ).toThrow(/REVIEW_LOGIN_OTP_CODE must be at least 4 characters/);
  });
});
