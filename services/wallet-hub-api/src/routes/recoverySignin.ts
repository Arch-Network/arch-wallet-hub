/**
 * Email sign-in: the inbox is proven before any wallet exists, and an
 * email signs in to exactly one wallet per app.
 *
 *   POST /recovery/email/signin  { email }
 *     ├─ rate-limit by sha256(email), shared with /init
 *     ├─ Turnkey INIT_OTP_V3 under the parent org -- no lookup, no create
 *     └─ { challengeId, otpEncryptionTargetBundle, emailMasked, expiresAt }
 *
 *   POST /recovery/email/signin/verify  { challengeId, encryptedOtpBundle }
 *     ├─ VERIFY_OTP_V2, 5 attempts per challenge. The client encrypted
 *     │  the code and its session public key to Turnkey's enclave; the
 *     │  Hub never sees the code.
 *     ├─ under the per-(app, email) lock: the wallet the email already
 *     │  signs in to, else its wallet from before sign-in existed, else
 *     │  a new one -- pinned to the email (turnkey_resources.verified_email)
 *     └─ { verificationToken, organizationId, walletId, ... }
 *
 *   POST /recovery/email/signin/session
 *       { challengeId, verificationToken, publicKey, clientSignature }
 *     └─ OTP_LOGIN_V2 in that challenge's wallet -> { session, ... }
 *
 * SECURITY:
 *   - /signin does the same work for every email, so its answer says
 *     nothing about whether a wallet exists.
 *   - A wallet is created only for an email whose code verified, and the
 *     unique verified_email index keeps it to one per (app, email).
 *   - The verification token is bound to the client's key: OTP_LOGIN_V2
 *     needs that key's signature, so the token alone opens nothing.
 *   - /session opens only the wallet its challenge resolved, never one
 *     looked up from the (client-supplied) token's contact.
 *   - The caller's own externalUserId is never accepted: a new wallet
 *     belongs to a fresh Hub user, so no existing user gains a credential
 *     without that user's session (requireSessionForExistingUser).
 */

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { VerificationToken } from "@turnkey/sdk-types";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { withDbTransaction } from "../db/tx.js";
import { getDbPool } from "../db/pool.js";
import { getOrCreateUserByExternalId, updateUserRecoveryEmail } from "../db/apps.js";
import {
  findEmailWalletByRecoveryEmail,
  findEmailWalletByVerifiedEmail,
  insertTurnkeyResource,
  lockEmailWallets,
  pinVerifiedEmail,
  type EmailWalletRow
} from "../db/queries.js";
import {
  countRecentChallenges,
  getRecoveryChallenge,
  hashEmailForRateLimit,
  incrementRecoveryAttemptIfUnderCap,
  insertRecoveryChallenge,
  markRecoveryChallengeStatus,
  maskAddress,
  maskEmail,
  otpUserIdentifier,
  updateRecoveryChallengeCandidates,
  type RecoveryCandidate
} from "../db/recovery.js";
import { classifyRecoveryChallengeAvailability } from "../recovery/otpObservability.js";
import { getTurnkeyClient } from "../turnkey/store.js";
import { auditEvent } from "../audit/audit.js";

// Long enough to sign the login message and call /session.
const VERIFICATION_TOKEN_TTL_SECONDS = "300";
// The longest session Arch Wallet and arch-prime keep.
const SESSION_TTL_SECONDS = 60 * 60;

const SigninBody = Type.Object({
  email: Type.String({ format: "email" })
});

const SigninResponse = Type.Object({
  challengeId: Type.String(),
  otpEncryptionTargetBundle: Type.String(),
  emailMasked: Type.String(),
  expiresAt: Type.String()
});

const VerifyBody = Type.Object({
  challengeId: Type.String({ format: "uuid" }),
  encryptedOtpBundle: Type.String({ minLength: 1 })
});

const VerifyResponse = Type.Object({
  verificationToken: Type.String(),
  organizationId: Type.String(),
  rootUserId: Type.Union([Type.String(), Type.Null()]),
  walletId: Type.Union([Type.String(), Type.Null()]),
  defaultAddress: Type.Union([Type.String(), Type.Null()]),
  defaultPublicKeyHex: Type.Union([Type.String(), Type.Null()]),
  externalUserId: Type.Union([Type.String(), Type.Null()]),
  authMethod: Type.Literal("email")
});

const SessionBody = Type.Object({
  challengeId: Type.String({ format: "uuid" }),
  verificationToken: Type.String({ minLength: 1 }),
  publicKey: Type.String({ minLength: 1 }),
  clientSignature: Type.Object({
    scheme: Type.Literal("CLIENT_SIGNATURE_SCHEME_API_P256"),
    publicKey: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    signature: Type.String({ minLength: 1 })
  })
});

const SessionResponse = Type.Object({
  session: Type.String(),
  organizationId: Type.String(),
  expiresInSeconds: Type.Integer()
});

export type SigninOptions = {
  maxPerWindow: number;
  windowMs: number;
  challengeTtlMs: number;
  maxVerifyAttempts: number;
  /** The Hub's OTP email settings, as /start sends them to INIT_OTP_AUTH. */
  otpEmail: () => Record<string, unknown> | undefined;
};

/** INIT_OTP_V3 takes the app name and sender fields beside, not inside, emailCustomization. */
function initOtpEmailParams(settings: Record<string, unknown> | undefined) {
  const { appName, sendFromEmailName, sendFromEmailAddress, replyToEmailAddress, ...emailCustomization } =
    settings ?? {};
  return {
    appName: typeof appName === "string" ? appName : "Arch Wallet",
    ...(typeof sendFromEmailAddress === "string" ? { sendFromEmailAddress } : {}),
    ...(typeof sendFromEmailName === "string" ? { sendFromEmailSenderName: sendFromEmailName } : {}),
    ...(typeof replyToEmailAddress === "string" ? { replyToEmailAddress } : {}),
    ...(Object.keys(emailCustomization).length ? { emailCustomization } : {})
  };
}

/**
 * The email a verification token attests. Only for tokens the Hub just
 * received from VERIFY_OTP_V2 itself: the signature is not checked here.
 */
function verifiedContact(verificationToken: string): string {
  const payload = verificationToken.split(".")[1] ?? "";
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as VerificationToken;
  if (typeof claims.contact !== "string" || !claims.contact) {
    throw new Error("Turnkey verification token has no contact");
  }
  return claims.contact.trim();
}

type NetworkDefaults = { addressFormat: string; derivationPath: string };

function networkDefaults(networkHint: string | undefined): NetworkDefaults {
  return networkHint?.toLowerCase() === "mainnet"
    ? { addressFormat: "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR", derivationPath: "m/86'/0'/0'/0/0" }
    : { addressFormat: "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR", derivationPath: "m/86'/1'/0'/0/0" };
}

async function createEmailWalletForNewUser(
  client: PoolClient,
  params: {
    appId: string;
    email: string;
    network: NetworkDefaults;
    log: { warn: (obj: object, msg: string) => void };
  }
): Promise<EmailWalletRow> {
  const externalUserId = `email-${randomUUID()}`;
  const user = await getOrCreateUserByExternalId(client, { appId: params.appId, externalUserId });
  await updateUserRecoveryEmail(client, { appId: params.appId, userId: user.id, email: params.email });

  const turnkey = getTurnkeyClient() as any;
  const created = await turnkey.createSubOrganizationWithEmailWallet({
    subOrganizationName: `arch-${params.appId}-${externalUserId}-email`,
    rootUser: { userName: externalUserId, userEmail: params.email },
    wallet: {
      walletName: `arch-embedded-${user.id.slice(0, 8)}-${Date.now().toString(36)}`,
      addressFormat: params.network.addressFormat,
      path: params.network.derivationPath
    }
  });

  const defaultAddress: string | null = created.addresses[0] ?? null;
  let defaultPublicKeyHex: string | null = null;
  try {
    const res = await turnkey.getWalletAccountsForOrganization({
      organizationId: created.subOrganizationId,
      walletId: created.walletId
    });
    const match = (Array.isArray(res?.accounts) ? res.accounts : []).find(
      (a: any) => a?.address === defaultAddress
    );
    defaultPublicKeyHex = typeof match?.publicKey === "string" ? match.publicKey : null;
  } catch (e: any) {
    params.log.warn(
      { err: String(e?.message ?? e), orgId: created.subOrganizationId },
      "recovery.signin.public_key_lookup_failed"
    );
  }

  const resource = await insertTurnkeyResource(client, {
    appId: params.appId,
    userId: user.id,
    organizationId: created.subOrganizationId,
    turnkeyRootUserId: created.rootUserId ?? null,
    walletId: created.walletId,
    vaultId: null,
    keyId: null,
    policyId: null,
    defaultAddress,
    defaultPublicKeyHex,
    defaultAddressFormat: params.network.addressFormat,
    defaultDerivationPath: params.network.derivationPath,
    authMethod: "email",
    keyVerified: defaultPublicKeyHex !== null
  });
  return { ...resource, external_user_id: externalUserId };
}

function toCandidate(row: EmailWalletRow): RecoveryCandidate {
  return {
    candidateToken: "",
    resourceId: row.id,
    userId: row.user_id!,
    externalUserId: row.external_user_id,
    organizationId: row.organization_id,
    rootUserId: row.turnkey_root_user_id,
    otpId: null,
    walletLabel: (row.default_address && `Wallet ${row.default_address.slice(-4)}`) || "Arch Wallet",
    addressMasked: maskAddress(row.default_address),
    walletId: row.wallet_id,
    defaultAddress: row.default_address,
    defaultPublicKeyHex: row.default_public_key_hex,
    createdAt: row.created_at,
    authMethod: "email"
  };
}


export function registerEmailSigninRoutes(server: FastifyInstance, options: SigninOptions) {
  server.post(
    "/recovery/email/signin",
    {
      schema: {
        summary: "Email sign-in: email a code; no wallet is looked up or created",
        tags: ["recovery"],
        body: SigninBody,
        response: { 200: SigninResponse }
      }
    },
    async (request, reply) => {
      const appId = (request as any).app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const db = getDbPool();
      const email = (request.body as typeof SigninBody.static).email.trim();
      const emailHash = hashEmailForRateLimit(email);

      // Counts only /signin's own challenges, one per request whatever the
      // email: /init stores a row only for an email that has a wallet, so
      // counting those would make this 429 an existence oracle.
      const recentCount = await withDbTransaction(db, (client) =>
        countRecentChallenges(client, { appId, emailHash, windowMs: options.windowMs, signinOnly: true })
      );
      if (recentCount >= options.maxPerWindow) {
        request.log.warn({ appId, emailHash, recentCount }, "recovery.signin.rate_limited");
        return reply.tooManyRequests("Too many sign-in attempts for this email; try again later");
      }

      const otp = await getTurnkeyClient().initOtp({
        contact: email,
        userIdentifier: otpUserIdentifier(appId, email),
        expirationSeconds: String(options.challengeTtlMs / 1000),
        ...initOtpEmailParams(options.otpEmail())
      });

      const challenge = await withDbTransaction(db, async (client) => {
        const row = await insertRecoveryChallenge(client, {
          appId,
          emailHash,
          candidates: [],
          ttlMs: options.challengeTtlMs,
          otpId: otp.otpId
        });
        await auditEvent({
          client,
          appId,
          requestId: request.id,
          userId: null,
          eventType: "recovery.signin",
          entityType: "recovery_challenge",
          entityId: row.id,
          turnkeyActivityId: otp.activityId,
          turnkeyRequestId: null,
          payloadJson: { emailHash },
          outcome: "succeeded"
        });
        return row;
      });

      return {
        challengeId: challenge.id,
        otpEncryptionTargetBundle: otp.otpEncryptionTargetBundle,
        emailMasked: maskEmail(email),
        expiresAt: challenge.expires_at
      };
    }
  );

  server.post(
    "/recovery/email/signin/verify",
    {
      schema: {
        summary:
          "Verify the encrypted code; returns the email's one wallet, creating it if the email has none",
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
      const audit = (client: PoolClient, outcome: "succeeded" | "failed", payloadJson: object, userId: string | null = null) =>
        auditEvent({
          client,
          appId,
          requestId: request.id,
          userId,
          eventType: "recovery.signin.verify",
          entityType: "recovery_challenge",
          entityId: body.challengeId,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson,
          outcome
        });

      const challenge = await withDbTransaction(db, (client) =>
        getRecoveryChallenge(client, { appId, id: body.challengeId })
      );
      if (!challenge?.otp_id) return reply.notFound("Unknown challenge");
      const availability = classifyRecoveryChallengeAvailability(challenge);
      if (availability === "not_pending") return reply.gone("Challenge already consumed or expired");
      if (availability === "expired") {
        await withDbTransaction(db, (client) =>
          markRecoveryChallengeStatus(client, { id: challenge.id, status: "expired" })
        );
        return reply.gone("Challenge expired");
      }

      // Counted before Turnkey sees the code, in one UPDATE, so
      // concurrent guesses cannot slip past the cap. A refusal leaves the
      // status alone: it is also what a verify racing one that just
      // consumed the challenge gets, and that one's /session must still work.
      const counted = await withDbTransaction(db, (client) =>
        incrementRecoveryAttemptIfUnderCap(client, {
          id: challenge.id,
          appId,
          maxAttempts: options.maxVerifyAttempts
        })
      );
      if (!counted) {
        await withDbTransaction(db, (client) => audit(client, "failed", { reason: "attempt_refused" }));
        return reply.tooManyRequests("Too many verification attempts");
      }

      let verificationToken: string;
      try {
        ({ verificationToken } = await getTurnkeyClient().verifyOtp({
          otpId: challenge.otp_id,
          encryptedOtpBundle: body.encryptedOtpBundle,
          expirationSeconds: VERIFICATION_TOKEN_TTL_SECONDS
        }));
      } catch (err: any) {
        request.log.warn(
          { appId, challengeId: challenge.id, attempt: counted.attempts, err: String(err?.message ?? err) },
          "recovery.signin.verify.rejected"
        );
        await withDbTransaction(db, (client) =>
          audit(client, "failed", { reason: "invalid_code", attempt: counted.attempts })
        );
        return reply.unauthorized("Invalid or expired code");
      }

      const email = verifiedContact(verificationToken);
      if (hashEmailForRateLimit(email) !== challenge.email_hash) {
        throw new Error("Turnkey verified a different email than this challenge was sent to");
      }

      // ponytail: the transaction holds a pool connection through a
      // Turnkey create (up to its 30 s activity poll), so a replica runs at
      // most pool-size first sign-ins at once. If bursts outgrow that,
      // commit a claim row under a short lock and have waiters poll it.
      const wallet = await withDbTransaction(db, async (client) => {
        await lockEmailWallets(client, { appId, email });
        let row = await findEmailWalletByVerifiedEmail(client, { appId, email });
        let created = false;
        if (!row) {
          row = await findEmailWalletByRecoveryEmail(client, {
            appId,
            email,
            rootOrganizationId: server.config.TURNKEY_ORGANIZATION_ID
          });
          if (!row) {
            row = await createEmailWalletForNewUser(client, {
              appId,
              email,
              network: networkDefaults(request.headers["x-network"] as string | undefined),
              log: request.log
            });
            created = true;
          }
          await pinVerifiedEmail(client, { appId, resourceId: row.id, email });
        }
        await updateRecoveryChallengeCandidates(client, { id: challenge.id, candidates: [toCandidate(row)] });
        await markRecoveryChallengeStatus(client, { id: challenge.id, status: "consumed" });
        await audit(client, "succeeded", { resourceId: row.id, created }, row.user_id);
        return row;
      });

      return {
        verificationToken,
        organizationId: wallet.organization_id,
        rootUserId: wallet.turnkey_root_user_id,
        walletId: wallet.wallet_id,
        defaultAddress: wallet.default_address,
        defaultPublicKeyHex: wallet.default_public_key_hex,
        externalUserId: wallet.external_user_id,
        authMethod: "email" as const
      };
    }
  );

  server.post(
    "/recovery/email/signin/session",
    {
      schema: {
        summary: "Open a Turnkey session for the client's key in the wallet a verified sign-in resolved",
        tags: ["recovery"],
        body: SessionBody,
        response: { 200: SessionResponse }
      }
    },
    async (request, reply) => {
      const appId = (request as any).app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const db = getDbPool();
      const body = request.body as typeof SessionBody.static;
      const challenge = await withDbTransaction(db, (client) =>
        getRecoveryChallenge(client, { appId, id: body.challengeId })
      );
      const wallet =
        challenge?.otp_id && challenge.status === "consumed" && Date.parse(challenge.expires_at) > Date.now()
          ? challenge.candidates[0]
          : undefined;
      if (!wallet) return reply.unauthorized("Sign-in expired; request a new code");

      const audit = (outcome: "succeeded" | "failed", payloadJson: object, turnkeyActivityId: string | null) =>
        withDbTransaction(db, (client) =>
          auditEvent({
            client,
            appId,
            requestId: request.id,
            userId: wallet.userId,
            eventType: "recovery.signin.session",
            entityType: "recovery_challenge",
            entityId: body.challengeId,
            turnkeyActivityId,
            turnkeyRequestId: null,
            payloadJson,
            outcome
          })
        );

      let login: { session: string; activityId: string };
      try {
        login = await getTurnkeyClient().otpLogin({
          organizationId: wallet.organizationId,
          verificationToken: body.verificationToken,
          publicKey: body.publicKey,
          clientSignature: body.clientSignature,
          expirationSeconds: String(SESSION_TTL_SECONDS)
        });
      } catch (err: any) {
        request.log.warn(
          { appId, challengeId: body.challengeId, err: String(err?.message ?? err) },
          "recovery.signin.session.rejected"
        );
        await audit("failed", { resourceId: wallet.resourceId }, null);
        return reply.unauthorized("Invalid verification");
      }

      await audit("succeeded", { resourceId: wallet.resourceId }, login.activityId);
      return {
        session: login.session,
        organizationId: wallet.organizationId,
        expiresInSeconds: SESSION_TTL_SECONDS
      };
    }
  );
}
