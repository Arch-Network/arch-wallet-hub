/**
 * Email OTP recovery routes.
 *
 * Used in three situations:
 *
 *   1. Passkey wallet, lost device:
 *      the user has the recovery email but not the authenticator;
 *      the verify response returns a recovered API key, which the
 *      client uses to mint a fresh WebAuthn credential and attach
 *      it to the sub-org's root user.
 *
 *   2. Email wallet, fresh device:
 *      the user has the recovery email and no signing material at
 *      all; the recovered API key boots an IndexedDB session via
 *      STAMP_LOGIN so the new device can sign.
 *
 *   3. Either wallet type, accidental data clear:
 *      same OTP flow re-bootstraps the session on the same device.
 *
 * Flow overview:
 *
 *   POST /recovery/email/init  { email }
 *     ├─ rate-limit by sha256(email) (3 inits / hour / app)
 *     ├─ findUsersByRecoveryEmail; for each user, list their
 *     │  sub-org turnkey_resources (parent-org rows filtered as a
 *     │  defence-in-depth check against legacy data)
 *     ├─ persist a recovery_challenges row with all candidates
 *     └─ returns { challengeId, candidates: [...masked + authMethod...],
 *                  emailMasked, expiresAt }
 *
 *   POST /recovery/email/start  { challengeId, candidateToken, email }
 *     ├─ resolve candidate selected by the user
 *     ├─ call Turnkey INIT_OTP_AUTH for that sub-org only
 *     ├─ persist otpId on that candidate
 *     └─ returns { emailMasked, expiresAt }
 *
 *   POST /recovery/email/verify
 *     { challengeId, candidateToken, code, ephemeralPublicKey,
 *       externalUserId? }
 *     ├─ load challenge, validate not expired, attempts < 5
 *     ├─ resolve candidate by candidateToken
 *     ├─ call Turnkey OTP_AUTH(otpId, code, targetPublicKey) ->
 *     │  returns HPKE-encrypted credentialBundle
 *     ├─ mark challenge consumed
 *     └─ return { credentialBundle, organizationId, walletId,
 *                  defaultAddress, defaultPublicKeyHex,
 *                  externalUserId, authMethod, expiresInSeconds }
 *
 * Security posture:
 *
 *   - Anti-enumeration: an `email` that matches zero users still
 *     gets a 200 response with an empty `candidates` array, no
 *     OTP sent. UI copy must read "If a wallet exists for this
 *     email, you'll receive a code" so the no-arrival case looks
 *     identical to a hit.
 *
 *   - Rate limits: 3 inits / email / hour, 5 verify attempts /
 *     challenge, 10-minute OTP TTL. (Hard-coded; flag-driven later.)
 *
 *   - The Hub never touches the user's signing keys at any point.
 *     `credentialBundle` is HPKE-encrypted to the client-supplied
 *     `ephemeralPublicKey`; the Hub cannot decrypt it. The Hub
 *     ALSO never sees the recovery API key itself -- only the
 *     ciphertext goes through.
 */

import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { withDbTransaction } from "../db/tx.js";
import { getDbPool } from "../db/pool.js";
import { findUsersByRecoveryEmail, getUserByExternalId } from "../db/apps.js";
import { listTurnkeyResourcesForUserForApp } from "../db/queries.js";
import {
  computeCandidateToken,
  countRecentChallenges,
  getRecoveryChallenge,
  hashEmailForRateLimit,
  incrementRecoveryAttempts,
  insertRecoveryChallenge,
  markRecoveryChallengeStatus,
  maskAddress,
  maskEmail,
  updateRecoveryChallengeCandidates,
  type RecoveryCandidate
} from "../db/recovery.js";
import { getTurnkeyClient } from "../turnkey/store.js";
import { auditEvent } from "../audit/audit.js";

// Bumped from the original 3/hour after early field reports of
// legitimate users (and our own QA) hitting the cap during a single
// debugging session. The Hub's per-sub-org Turnkey OTP cost is
// negligible and the rate-limit shape (empty candidates + 200) is
// preserved for anti-enumeration, so going to 10/hour doesn't widen
// any abuse surface meaningfully. If we see real abuse later we can
// either lower this or switch to a token-bucket with a shorter window.
const RATE_LIMIT_MAX_INITS = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const VERIFY_MAX_ATTEMPTS = 5;
const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RECOVERY_API_KEY_TTL_SECONDS = "900"; // 15 minutes

function buildOtpEmailCustomization(
  config: Record<string, unknown>
): Record<string, unknown> | undefined {
  const customization: Record<string, unknown> = {};
  const rawJson = config.TURNKEY_OTP_EMAIL_CUSTOMIZATION_JSON;
  if (typeof rawJson === "string" && rawJson.trim()) {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("TURNKEY_OTP_EMAIL_CUSTOMIZATION_JSON must be a JSON object");
    }
    Object.assign(customization, parsed);
  }

  const envMappings: Array<[string, string]> = [
    ["TURNKEY_OTP_EMAIL_APP_NAME", "appName"],
    ["TURNKEY_OTP_EMAIL_LOGO_URL", "logoUrl"],
    ["TURNKEY_OTP_EMAIL_MAGIC_LINK_TEMPLATE", "magicLinkTemplate"],
    ["TURNKEY_OTP_EMAIL_TEMPLATE_ID", "templateId"],
    ["TURNKEY_OTP_EMAIL_SENDER_NAME", "sendFromEmailName"],
    ["TURNKEY_OTP_EMAIL_SENDER_ADDRESS", "sendFromEmailAddress"],
    ["TURNKEY_OTP_EMAIL_REPLY_TO_ADDRESS", "replyToEmailAddress"]
  ];
  for (const [envKey, turnkeyKey] of envMappings) {
    const value = config[envKey];
    if (typeof value === "string" && value.trim()) {
      customization[turnkeyKey] = value.trim();
    }
  }

  return Object.keys(customization).length ? customization : undefined;
}

const InitBody = Type.Object({
  email: Type.String({ format: "email" })
});

// NB: `defaultAddress` was previously part of this shape; it was
// removed because returning the full address pre-OTP turned the /init
// endpoint into a wallet-enumeration oracle. The unmasked address is
// only revealed in VerifyResponse after a successful OTP_AUTH.
const InitCandidate = Type.Object({
  candidateToken: Type.String(),
  resourceId: Type.Optional(Type.String()),
  walletLabel: Type.String(),
  addressMasked: Type.String(),
  createdAt: Type.String(),
  // Retained for backwards compatibility with already-deployed SDKs;
  // populated as `false` for any sub-org wallet (the only kind that
  // can appear here -- parent-org rows are filtered out upstream).
  isCustodial: Type.Boolean(),
  // New: tells the client whether to drive WebAuthn registration
  // (passkey) or IndexedDB-session bootstrap (email) after verify.
  authMethod: Type.Union([
    Type.Literal("passkey"),
    Type.Literal("email")
  ])
});

const InitResponse = Type.Object({
  challengeId: Type.String(),
  candidates: Type.Array(InitCandidate),
  emailMasked: Type.String(),
  expiresAt: Type.String()
});

const StartBody = Type.Object({
  challengeId: Type.String({ minLength: 1 }),
  candidateToken: Type.String({ minLength: 1 }),
  email: Type.String({ format: "email" })
});

const StartResponse = Type.Object({
  emailMasked: Type.String(),
  expiresAt: Type.String()
});

const VerifyBody = Type.Object({
  challengeId: Type.String({ minLength: 1 }),
  candidateToken: Type.String({ minLength: 1 }),
  code: Type.String({ minLength: 4 }),
  ephemeralPublicKey: Type.String({ minLength: 1 }),
  externalUserId: Type.Optional(Type.String({ minLength: 1 }))
});

const VerifyResponse = Type.Object({
  credentialBundle: Type.String(),
  organizationId: Type.String(),
  /** Sub-org root user id; client targets this when stamping
   *  CREATE_AUTHENTICATORS with the recovered API key. */
  rootUserId: Type.Union([Type.String(), Type.Null()]),
  walletId: Type.Union([Type.String(), Type.Null()]),
  defaultAddress: Type.Union([Type.String(), Type.Null()]),
  defaultPublicKeyHex: Type.Union([Type.String(), Type.Null()]),
  externalUserId: Type.Union([Type.String(), Type.Null()]),
  /**
   * Echoed from the candidate so the client knows whether to mount
   * the verified bundle for a) WebAuthn re-enrollment (passkey
   * wallets) or b) IndexedDB-session bootstrap (email wallets).
   */
  authMethod: Type.Union([
    Type.Literal("passkey"),
    Type.Literal("email")
  ]),
  expiresInSeconds: Type.Integer()
});

export const registerRecoveryRoutes: FastifyPluginAsync = async (server) => {
  server.post(
    "/recovery/email/init",
    {
      schema: {
        summary:
          "Begin email-OTP recovery: enumerate candidate sub-org wallets for the email and mint per-sub-org OTPs",
        tags: ["recovery"],
        body: InitBody,
        response: { 200: InitResponse }
      }
    },
    async (request, reply) => {
      const appId = (request as any).app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const db = getDbPool();
      const body = request.body as typeof InitBody.static;
      const email = body.email.trim();
      const emailHash = hashEmailForRateLimit(email);

      // Hard rate-limit by hashed email. We don't tell the caller they
      // hit the cap -- returning 200 with an empty candidates list is
      // intentional so probing is not informative.
      const recentCount = await withDbTransaction(db, (client) =>
        countRecentChallenges(client, {
          appId,
          emailHash,
          windowMs: RATE_LIMIT_WINDOW_MS
        })
      );

      const rootOrgId = server.config.TURNKEY_ORGANIZATION_ID;
      const expiresIso = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
      const emailMasked = maskEmail(email);

      // Constant-shape "no candidates" reply we return on rate-limit
      // hits, unknown emails, and emails with only custodial wallets.
      const emptyResponse = (challengeId: string) => ({
        challengeId,
        candidates: [],
        emailMasked,
        expiresAt: expiresIso
      });

      if (recentCount >= RATE_LIMIT_MAX_INITS) {
        request.log.warn({ emailHash }, "recovery.init.rate_limited");
        // Synthesise a non-existent challenge id so the client UX
        // shape is identical to the success path.
        return emptyResponse(`chal_blocked_${Date.now().toString(36)}`);
      }

      const users = await withDbTransaction(db, (client) =>
        findUsersByRecoveryEmail(client, { appId, email })
      );

      // Walk every user, collect their sub-org wallets. Post-P4
      // the only kinds we expect are passkey and email sub-org
      // wallets; the parent-org filter below is now a defence-in-
      // depth check against legacy DB rows that pre-date the
      // migration, not a meaningful product distinction.
      const sourceCandidates: Array<{
        resourceId: string;
        userId: string;
        externalUserId: string | null;
        organizationId: string;
        rootUserId: string | null;
        walletId: string | null;
        walletLabel: string;
        defaultAddress: string | null;
        defaultPublicKeyHex: string | null;
        createdAt: string;
        authMethod: "passkey" | "email";
      }> = [];

      for (const user of users) {
        const rows = await withDbTransaction(db, (client) =>
          listTurnkeyResourcesForUserForApp(client, { appId, userId: user.id })
        );
        for (const row of rows) {
          // Defence-in-depth: a legacy parent-org row could still
          // exist in the DB. Turnkey OTP_AUTH is per sub-org, and
          // the parent org is a multi-user root org, so attempting
          // to recover into it would just fail. Skip silently.
          if (row.organization_id === rootOrgId) continue;
          // Default NULL auth_method (legacy rows predating migration
          // 011) to "passkey" -- there were no email wallets before
          // that migration shipped.
          const authMethod: "passkey" | "email" =
            row.auth_method === "email" ? "email" : "passkey";
          sourceCandidates.push({
            resourceId: row.id,
            userId: user.id,
            externalUserId: user.external_user_id,
            organizationId: row.organization_id,
            rootUserId: (row as any).turnkey_root_user_id ?? null,
            walletId: row.wallet_id,
            walletLabel:
              (row.default_address && `Wallet ${row.default_address.slice(-4)}`) ||
              "Arch Wallet",
            defaultAddress: row.default_address,
            defaultPublicKeyHex: (row as any).default_public_key_hex ?? null,
            createdAt: row.created_at,
            authMethod
          });
        }
      }

      if (sourceCandidates.length === 0) {
        await withDbTransaction(db, (client) =>
          auditEvent({
            client,
            appId,
            requestId: request.id,
            userId: null,
            eventType: "recovery.init",
            entityType: "recovery_challenge",
            entityId: null,
            turnkeyActivityId: null,
            turnkeyRequestId: null,
            payloadJson: { emailHash, candidateCount: 0 },
            outcome: "succeeded"
          })
        );
        return emptyResponse(`chal_empty_${Date.now().toString(36)}`);
      }

      const candidates: RecoveryCandidate[] = [];
      const failed: Array<{ resourceId: string; error: string }> = [];

      for (const c of sourceCandidates) {
        if (!c.rootUserId) {
          // We need a root user id to address INIT_OTP_AUTH at -- if
          // the resource row was inserted before migration 007
          // (turnkey_root_user_id) we can't recover that wallet via
          // OTP. Skip silently; user can still recover other wallets
          // tied to the same email.
          failed.push({ resourceId: c.resourceId, error: "missing_root_user_id" });
          continue;
        }
        candidates.push({
          candidateToken: "", // filled after we know challengeId
          resourceId: c.resourceId,
          userId: c.userId,
          externalUserId: c.externalUserId,
          organizationId: c.organizationId,
          rootUserId: c.rootUserId,
          otpId: null,
          walletLabel: c.walletLabel,
          addressMasked: maskAddress(c.defaultAddress),
          walletId: c.walletId,
          defaultAddress: c.defaultAddress,
          defaultPublicKeyHex: c.defaultPublicKeyHex,
          createdAt: c.createdAt,
          authMethod: c.authMethod
        });
      }

      if (candidates.length === 0) {
        await withDbTransaction(db, (client) =>
          auditEvent({
            client,
            appId,
            requestId: request.id,
            userId: null,
            eventType: "recovery.init",
            entityType: "recovery_challenge",
            entityId: null,
            turnkeyActivityId: null,
            turnkeyRequestId: null,
            payloadJson: { emailHash, candidateCount: 0, failures: failed },
            outcome: "failed"
          })
        );
        return emptyResponse(`chal_otp_${Date.now().toString(36)}`);
      }

      // Persist with placeholder tokens, then back-fill once we know
      // the row id (which forms half of the hash) and persist again.
      // Two writes is fine -- the table is low-volume.
      const challenge = await withDbTransaction(db, (client) =>
        insertRecoveryChallenge(client, {
          appId,
          emailHash,
          candidates,
          ttlMs: CHALLENGE_TTL_MS
        })
      );

      const tokensFilled = candidates.map((c) => ({
        ...c,
        candidateToken: computeCandidateToken(challenge.id, c.resourceId)
      }));

      // Re-write candidates with tokens; verify resolves by the
      // (challengeId + token) pair so persisting these is required.
      await withDbTransaction(db, async (client) => {
        await client.query(
          `UPDATE recovery_challenges SET candidates = $2::jsonb WHERE id = $1`,
          [challenge.id, JSON.stringify(tokensFilled)]
        );
        await auditEvent({
          client,
          appId,
          requestId: request.id,
          userId: null,
          eventType: "recovery.init",
          entityType: "recovery_challenge",
          entityId: challenge.id,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: {
            emailHash,
            candidateCount: tokensFilled.length,
            failures: failed
          },
          outcome: "succeeded"
        });
      });

      // SECURITY: do NOT return `defaultAddress` (full address) here.
      // Doing so lets an attacker enumerate every wallet ever
      // registered with an email by calling /init with candidate
      // addresses. `addressMasked` is enough for the user to pick
      // which wallet to recover; the unmasked address is only
      // revealed after a successful OTP verification.
      return {
        challengeId: challenge.id,
        candidates: tokensFilled.map((c) => ({
          candidateToken: c.candidateToken,
          resourceId: c.resourceId,
          walletLabel: c.walletLabel,
          addressMasked: c.addressMasked,
          createdAt: c.createdAt,
          isCustodial: false,
          authMethod: c.authMethod
        })),
        emailMasked,
        expiresAt: challenge.expires_at
      };
    }
  );

  server.post(
    "/recovery/email/start",
    {
      schema: {
        summary:
          "Start email OTP recovery for one selected candidate wallet",
        tags: ["recovery"],
        body: StartBody,
        response: { 200: StartResponse }
      }
    },
    async (request, reply) => {
      const appId = (request as any).app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const db = getDbPool();
      const body = request.body as typeof StartBody.static;
      const email = body.email.trim();

      const challenge = await withDbTransaction(db, (client) =>
        getRecoveryChallenge(client, { appId, id: body.challengeId })
      );
      if (!challenge) return reply.notFound("Unknown challenge");
      if (challenge.status !== "pending") {
        return reply.gone("Challenge already consumed or expired");
      }
      if (new Date(challenge.expires_at).getTime() < Date.now()) {
        await withDbTransaction(db, (client) =>
          markRecoveryChallengeStatus(client, {
            id: challenge.id,
            status: "expired"
          })
        );
        return reply.gone("Challenge expired");
      }

      const candidateIndex = challenge.candidates.findIndex(
        (c) => c.candidateToken === body.candidateToken
      );
      if (candidateIndex < 0) return reply.badRequest("Unknown candidateToken");

      const candidate = challenge.candidates[candidateIndex]!;
      if (!candidate.rootUserId) {
        return reply.badRequest("Selected wallet cannot receive OTP recovery");
      }

      try {
        const turnkey = getTurnkeyClient();
        const { otpId } = await turnkey.initOtpAuth({
          organizationId: candidate.organizationId,
          userId: candidate.rootUserId,
          contact: email,
          emailCustomization: buildOtpEmailCustomization(server.config)
        });

        const candidates = challenge.candidates.map((c, i) =>
          i === candidateIndex ? { ...c, otpId } : c
        );
        await withDbTransaction(db, async (client) => {
          await updateRecoveryChallengeCandidates(client, {
            id: challenge.id,
            candidates
          });
          await auditEvent({
            client,
            appId,
            requestId: request.id,
            userId: candidate.userId,
            eventType: "recovery.otp_start",
            entityType: "recovery_challenge",
            entityId: challenge.id,
            turnkeyActivityId: null,
            turnkeyRequestId: null,
            payloadJson: { candidateResourceId: candidate.resourceId },
            outcome: "succeeded"
          });
        });

        return {
          emailMasked: maskEmail(email),
          expiresAt: challenge.expires_at
        };
      } catch (err: any) {
        request.log.warn(
          { resourceId: candidate.resourceId, err: String(err?.message ?? err) },
          "recovery.start.otp_failed"
        );
        await withDbTransaction(db, (client) =>
          auditEvent({
            client,
            appId,
            requestId: request.id,
            userId: candidate.userId,
            eventType: "recovery.otp_start",
            entityType: "recovery_challenge",
            entityId: challenge.id,
            turnkeyActivityId: null,
            turnkeyRequestId: null,
            payloadJson: {
              candidateResourceId: candidate.resourceId,
              error: String(err?.message ?? err)
            },
            outcome: "failed"
          })
        );
        return reply.internalServerError("Failed to send verification code");
      }
    }
  );

  server.post(
    "/recovery/email/verify",
    {
      schema: {
        summary:
          "Verify an OTP code; returns the HPKE-encrypted credential bundle the client decrypts to attach a new passkey",
        tags: ["recovery"],
        body: VerifyBody,
        response: { 200: VerifyResponse }
      }
    },
    async (request, reply) => {
      const appId = (request as any).app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const db = getDbPool();
      const body = request.body as typeof VerifyBody.static;

      const challenge = await withDbTransaction(db, (client) =>
        getRecoveryChallenge(client, { appId, id: body.challengeId })
      );
      if (!challenge) return reply.notFound("Unknown challenge");
      if (challenge.status !== "pending") {
        return reply.gone("Challenge already consumed or expired");
      }
      if (new Date(challenge.expires_at).getTime() < Date.now()) {
        await withDbTransaction(db, (client) =>
          markRecoveryChallengeStatus(client, {
            id: challenge.id,
            status: "expired"
          })
        );
        return reply.gone("Challenge expired");
      }
      if (challenge.attempts >= VERIFY_MAX_ATTEMPTS) {
        await withDbTransaction(db, (client) =>
          markRecoveryChallengeStatus(client, {
            id: challenge.id,
            status: "failed"
          })
        );
        return reply.tooManyRequests("Too many verification attempts");
      }

      const candidate = challenge.candidates.find(
        (c) => c.candidateToken === body.candidateToken
      );
      if (!candidate) return reply.badRequest("Unknown candidateToken");
      if (!candidate.otpId) {
        return reply.badRequest("Verification code has not been sent for this wallet");
      }

      // Optional sanity check -- if the client claims a particular
      // externalUserId (case a: lost passkey on-device), it must
      // match the candidate's user. Catches stale clients hitting an
      // older challenge.
      if (
        body.externalUserId &&
        candidate.externalUserId &&
        body.externalUserId !== candidate.externalUserId
      ) {
        return reply.badRequest("externalUserId does not match candidate");
      }

      await withDbTransaction(db, async (client) => {
        await incrementRecoveryAttempts(client, { id: challenge.id });
        await auditEvent({
          client,
          appId,
          requestId: request.id,
          userId: candidate.userId,
          eventType: "recovery.verify",
          entityType: "recovery_challenge",
          entityId: challenge.id,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: {
            candidateResourceId: candidate.resourceId,
            attempt: challenge.attempts + 1
          },
          outcome: "requested"
        });
      });

      try {
        const turnkey = getTurnkeyClient();
        const apiKeyName = `recovery-${Date.now().toString(36)}`;
        const otpResult = await turnkey.otpAuth({
          organizationId: candidate.organizationId,
          otpId: candidate.otpId,
          otpCode: body.code,
          targetPublicKey: body.ephemeralPublicKey,
          apiKeyName,
          expirationSeconds: RECOVERY_API_KEY_TTL_SECONDS
        });

        // Optionally validate that the user record's externalUserId
        // matches what the client supplied. We've checked equality
        // above; here we just make sure the user still exists.
        if (body.externalUserId) {
          await withDbTransaction(db, async (client) => {
            const user = await getUserByExternalId(client, {
              appId,
              externalUserId: body.externalUserId!
            });
            if (!user) {
              throw new Error("Bound externalUserId no longer exists");
            }
          });
        }

        await withDbTransaction(db, async (client) => {
          await markRecoveryChallengeStatus(client, {
            id: challenge.id,
            status: "consumed"
          });
          await auditEvent({
            client,
            appId,
            requestId: request.id,
            userId: candidate.userId,
            eventType: "recovery.verify",
            entityType: "recovery_challenge",
            entityId: challenge.id,
            turnkeyActivityId: otpResult.activityId,
            turnkeyRequestId: null,
            payloadJson: {
              candidateResourceId: candidate.resourceId,
              apiKeyId: otpResult.apiKeyId
            },
            outcome: "succeeded"
          });
        });

        return {
          credentialBundle: otpResult.credentialBundle,
          organizationId: candidate.organizationId,
          rootUserId: candidate.rootUserId,
          walletId: candidate.walletId,
          defaultAddress: candidate.defaultAddress,
          defaultPublicKeyHex: candidate.defaultPublicKeyHex,
          externalUserId: candidate.externalUserId,
          authMethod: candidate.authMethod,
          expiresInSeconds: Number(RECOVERY_API_KEY_TTL_SECONDS)
        };
      } catch (err: any) {
        await withDbTransaction(db, (client) =>
          auditEvent({
            client,
            appId,
            requestId: request.id,
            userId: candidate.userId,
            eventType: "recovery.verify",
            entityType: "recovery_challenge",
            entityId: challenge.id,
            turnkeyActivityId: null,
            turnkeyRequestId: null,
            payloadJson: {
              candidateResourceId: candidate.resourceId,
              error: String(err?.message ?? err)
            },
            outcome: "failed"
          })
        );
        return reply.unauthorized("Invalid or expired code");
      }
    }
  );
};
