/**
 * App-store review login.
 *
 * Google Play / App Store reviewers must be able to open a working
 * wallet to review the Android/iOS build, but the normal email-wallet
 * unlock flow depends on a Turnkey-sent OTP email that reviewers have
 * no inbox for. That blocks public releases.
 *
 * This module lets a SINGLE pre-provisioned "dummy" mainnet sub-org
 * wallet be unlocked with a fixed test email plus a static OTP code.
 * The recovery endpoints (`/recovery/email/{init,start,verify}`)
 * short-circuit Turnkey's OTP for that one email and instead hand the
 * client the exact same artefact the real flow would: an HPKE-encrypted
 * `credentialBundle` the client decrypts locally into a Turnkey API key
 * and spends once via STAMP_LOGIN.
 *
 * How the bundle is produced without Turnkey's OTP_AUTH:
 *
 *   - At provisioning time a permanent "review" API key is registered on
 *     the dummy sub-org's root user; its private half is injected as
 *     REVIEW_LOGIN_API_PRIVATE_KEY_HEX.
 *   - At verify time we HPKE-encrypt that private key to the client's
 *     ephemeral P-256 public key using the same primitive (`hpkeEncrypt`)
 *     and envelope (bs58check of `compressedEncappedKey || ciphertext`)
 *     that Turnkey's OTP_AUTH uses, so `@turnkey/crypto`'s
 *     `decryptCredentialBundle` on the client round-trips it unchanged.
 *
 * Security posture:
 *
 *   - Only the configured REVIEW_LOGIN_EMAIL is treated specially, and
 *     only when REVIEW_LOGIN_ENABLED=true. Every other email takes the
 *     normal, fully OTP-gated path.
 *   - The reward for presenting the static code is access to an isolated,
 *     fundless dummy sub-org. It cannot sign for or enumerate any real
 *     user; the Hub never sees real users' signing material here.
 *   - The review API key is intentionally shared with reviewers; treat
 *     the dummy wallet as public and keep no value in it.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hpkeEncrypt } from "@turnkey/crypto";
import bs58check from "bs58check";
import type { Env } from "../config/env.js";

/** Prefix that marks a synthetic review challenge id. The three recovery
 *  endpoints branch on this so the review path needs no DB row. */
export const REVIEW_CHALLENGE_PREFIX = "chal_review_";

/** Stable synthetic resource id for the single dummy wallet candidate. */
const REVIEW_RESOURCE_ID = "review-wallet";

/** Static "created" timestamp surfaced to the client candidate card. */
const REVIEW_CREATED_AT = "2024-01-01T00:00:00.000Z";

export interface ReviewLoginConfig {
  /** Normalised (trimmed, lowercased) test email handed to reviewers. */
  email: string;
  otpCode: string;
  organizationId: string;
  rootUserId: string;
  walletId: string;
  defaultAddress: string;
  defaultPublicKeyHex: string | null;
  externalUserId: string | null;
  /** Raw 32-byte P-256 private key (64 hex chars) of the review API key. */
  apiPrivateKeyHex: string;
}

/**
 * Resolve the review-login configuration, or null when the feature is
 * disabled. Env validation (config/env.ts) guarantees the required
 * fields are present whenever REVIEW_LOGIN_ENABLED is true, so the
 * non-null assertions below are safe.
 */
export function getReviewLoginConfig(config: Env): ReviewLoginConfig | null {
  if (!config.REVIEW_LOGIN_ENABLED) return null;
  return {
    email: config.REVIEW_LOGIN_EMAIL!.trim().toLowerCase(),
    otpCode: config.REVIEW_LOGIN_OTP_CODE!,
    organizationId: config.REVIEW_LOGIN_ORGANIZATION_ID!,
    rootUserId: config.REVIEW_LOGIN_ROOT_USER_ID!,
    walletId: config.REVIEW_LOGIN_WALLET_ID!,
    defaultAddress: config.REVIEW_LOGIN_DEFAULT_ADDRESS!,
    defaultPublicKeyHex: config.REVIEW_LOGIN_DEFAULT_PUBLIC_KEY_HEX ?? null,
    externalUserId: config.REVIEW_LOGIN_EXTERNAL_USER_ID ?? null,
    apiPrivateKeyHex: config.REVIEW_LOGIN_API_PRIVATE_KEY_HEX!,
  };
}

export function isReviewEmail(cfg: ReviewLoginConfig, email: string): boolean {
  return email.trim().toLowerCase() === cfg.email;
}

export function isReviewChallengeId(challengeId: unknown): boolean {
  return (
    typeof challengeId === "string" &&
    challengeId.startsWith(REVIEW_CHALLENGE_PREFIX)
  );
}

export function newReviewChallengeId(): string {
  return `${REVIEW_CHALLENGE_PREFIX}${randomBytes(16).toString("hex")}`;
}

/** Deterministic token binding the single candidate to its challenge id.
 *  Mirrors db/recovery.ts `computeCandidateToken` shape. */
export function reviewCandidateToken(challengeId: string): string {
  return createHash("sha256")
    .update(`${challengeId}:${REVIEW_RESOURCE_ID}`)
    .digest("hex");
}

/** Constant-time string comparison that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function reviewCandidateTokenMatches(
  challengeId: string,
  candidateToken: string,
): boolean {
  return safeEqual(reviewCandidateToken(challengeId), candidateToken);
}

export function reviewOtpMatches(
  cfg: ReviewLoginConfig,
  code: string,
): boolean {
  return safeEqual(cfg.otpCode, code.trim());
}

/** Masked address for the init candidate card (mirrors maskAddress). */
function maskReviewAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Produce a credential bundle byte-compatible with
 * `@turnkey/crypto`'s `decryptCredentialBundle`: bs58check of
 * `compressedEncappedPublicKey(33) || AES-GCM ciphertext`, HPKE-sealed
 * to the client's uncompressed ephemeral public key.
 *
 * Throws if `ephemeralPublicKeyHex` is not a 65-byte (0x04-prefixed)
 * uncompressed P-256 point; callers surface that as a 400.
 */
export function buildReviewCredentialBundle(
  apiPrivateKeyHex: string,
  ephemeralPublicKeyHex: string,
): string {
  if (!/^04[0-9a-fA-F]{128}$/.test(ephemeralPublicKeyHex)) {
    throw new Error("ephemeralPublicKey must be 65-byte uncompressed P-256 hex");
  }
  const plainTextBuf = new Uint8Array(Buffer.from(apiPrivateKeyHex, "hex"));
  const targetKeyBuf = new Uint8Array(Buffer.from(ephemeralPublicKeyHex, "hex"));
  const encrypted = hpkeEncrypt({ plainTextBuf, targetKeyBuf });
  return bs58check.encode(encrypted);
}

export interface ReviewInitCandidate {
  candidateToken: string;
  resourceId: string;
  walletLabel: string;
  addressMasked: string;
  createdAt: string;
  isCustodial: false;
  authMethod: "email";
}

export interface ReviewInitResponse {
  challengeId: string;
  candidates: ReviewInitCandidate[];
  emailMasked: string;
  expiresAt: string;
}

export function buildReviewInitResponse(
  cfg: ReviewLoginConfig,
  params: { emailMasked: string; ttlMs: number },
): ReviewInitResponse {
  const challengeId = newReviewChallengeId();
  const label =
    (cfg.defaultAddress && `Wallet ${cfg.defaultAddress.slice(-4)}`) ||
    "Arch Wallet";
  return {
    challengeId,
    candidates: [
      {
        candidateToken: reviewCandidateToken(challengeId),
        resourceId: REVIEW_RESOURCE_ID,
        walletLabel: label,
        addressMasked: maskReviewAddress(cfg.defaultAddress),
        createdAt: REVIEW_CREATED_AT,
        isCustodial: false,
        authMethod: "email",
      },
    ],
    emailMasked: params.emailMasked,
    expiresAt: new Date(Date.now() + params.ttlMs).toISOString(),
  };
}

export interface ReviewVerifyResponse {
  credentialBundle: string;
  organizationId: string;
  rootUserId: string | null;
  walletId: string | null;
  defaultAddress: string | null;
  defaultPublicKeyHex: string | null;
  externalUserId: string | null;
  authMethod: "email";
  expiresInSeconds: number;
}

export function buildReviewVerifyResponse(
  cfg: ReviewLoginConfig,
  params: { ephemeralPublicKey: string; expiresInSeconds: number },
): ReviewVerifyResponse {
  return {
    credentialBundle: buildReviewCredentialBundle(
      cfg.apiPrivateKeyHex,
      params.ephemeralPublicKey,
    ),
    organizationId: cfg.organizationId,
    rootUserId: cfg.rootUserId,
    walletId: cfg.walletId,
    defaultAddress: cfg.defaultAddress,
    defaultPublicKeyHex: cfg.defaultPublicKeyHex,
    externalUserId: cfg.externalUserId,
    authMethod: "email",
    expiresInSeconds: params.expiresInSeconds,
  };
}
