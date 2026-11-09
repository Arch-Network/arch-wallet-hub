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
 *     │  signs in to, else the wallet of the person who verified the email
 *     │  (a Google sign-up), else its wallet from before sign-in existed,
 *     │  else a new person and wallet -- pinned to the email
 *     │  (turnkey_resources.verified_email), the email verified on the person
 *     ├─ a Hub session and an Arch ID token (amr ["email"]) for that person,
 *     │  as /recovery/email/verify and the OAuth route answer
 *     └─ { verificationToken, organizationId, walletId, ..., sessionToken, idToken, ... }
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
 *     belongs to a fresh person, or to the person the email was already
 *     verified on, so no other user gains a credential without that user's
 *     session (requireSessionForExistingUser).
 */

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { withDbTransaction } from "../db/tx.js";
import { getDbPool } from "../db/pool.js";
import { claimEmailIdentity, createPerson, getIdentity, getPerson, getPersonByVerifiedEmail, setVerifiedPrimaryEmail, type PersonRow } from "../db/identities.js";
import { mintSessionForUser } from "../auth/sessionToken.js";
import { mintIdentityToken } from "../auth/idToken.js";
import {
  findEmailWalletByRecoveryEmail,
  findEmailWalletByVerifiedEmail,
  insertTurnkeyResource,
  listTurnkeyResourcesForUserForApp,
  lockEmailWallets,
  pinVerifiedEmail,
  type EmailWalletRow,
  type TurnkeyResourceRow
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
  authMethod: Type.Literal("email"),
  /** The person the code attested: a Hub session (whs_v1_, 24 h) and an Arch ID token (15 min, amr ["email"]). */
  sessionToken: Type.String(),
  sessionExpiresAt: Type.String(),
  idToken: Type.String(),
  idTokenExpiresAt: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  emailVerified: Type.Boolean()
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

type OtpVerification = {
  contact: string;
  tokenId: string;
  expiresAtMs: number;
  /** The key the bundle bound, when the token carries one. */
  publicKey: string | null;
};

/**
 * Claims in a Turnkey verification token. The signature is not checked:
 * verify only parses a token Turnkey just returned, and session compares
 * these claims with the challenge before Turnkey checks the signature.
 */
function readVerification(verificationToken: string): OtpVerification {
  let claims: Record<string, unknown>;
  try {
    const payload = verificationToken.split(".")[1] ?? "";
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Turnkey verification token is unreadable");
  }
  if (typeof claims.contact !== "string" || !claims.contact.trim()) {
    throw new Error("Turnkey verification token has no contact");
  }
  if (typeof claims.id !== "string" || !claims.id) {
    throw new Error("Turnkey verification token has no id");
  }
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new Error("Turnkey verification token has no exp");
  }
  const publicKey = typeof claims.public_key === "string"
    ? claims.public_key
    : typeof claims.publicKey === "string"
      ? claims.publicKey
      : null;
  return { contact: claims.contact.trim(), tokenId: claims.id, expiresAtMs: claims.exp * 1000, publicKey };
}

type NetworkDefaults = { addressFormat: string; derivationPath: string };

function networkDefaults(networkHint: string | undefined): NetworkDefaults {
  // The first verified sign-in pins this wallet for the email. Callers send
  // x-network: mainnet for a mainnet address; every other value is testnet,
  // matching POST /turnkey/email-wallets.
  return networkHint?.toLowerCase() === "mainnet"
    ? { addressFormat: "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR", derivationPath: "m/86'/0'/0'/0/0" }
    : { addressFormat: "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR", derivationPath: "m/86'/1'/0'/0/0" };
}

async function createEmailWallet(
  client: PoolClient,
  params: {
    appId: string;
    person: PersonRow;
    email: string;
    network: NetworkDefaults;
    log: { warn: (obj: object, msg: string) => void };
    onSubOrgCreated?: (created: { subOrganizationId: string; walletId: string; activityId: string }) => void;
  }
): Promise<EmailWalletRow> {
  const user = params.person;
  const externalUserId = user.external_user_id!;
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
  params.onSubOrgCreated?.({
    subOrganizationId: created.subOrganizationId,
    walletId: created.walletId,
    activityId: created.activityId
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

/**
 * An email or OAuth wallet this person can open with OTP_LOGIN. Passkey
 * wallets are not reusable here: pinning one is permanent, and the passkey
 * sub-org's user email is not this inbox.
 */
function selectSignInWallet(resources: TurnkeyResourceRow[], rootOrganizationId: string): TurnkeyResourceRow | null {
  const usable = resources.filter(
    (r) =>
      (r.auth_method === "email" || r.auth_method === "oauth") &&
      r.organization_id !== rootOrganizationId &&
      r.turnkey_root_user_id &&
      r.default_address &&
      r.verified_email === null
  );
  return usable.find((r) => r.auth_method === "email") ?? usable.find((r) => r.auth_method === "oauth") ?? null;
}

/** The person `email` is already verified on, and their sign-in wallet if they have one. */
async function findVerifiedPersonWallet(
  client: PoolClient,
  params: { appId: string; email: string; rootOrganizationId: string }
): Promise<{ person: PersonRow; wallet: EmailWalletRow | null } | null> {
  const person = await getPersonByVerifiedEmail(client, params);
  if (!person) return null;
  const resources = await listTurnkeyResourcesForUserForApp(client, { appId: params.appId, userId: person.id });
  const wallet = selectSignInWallet(resources, params.rootOrganizationId);
  return { person, wallet: wallet ? { ...wallet, external_user_id: person.external_user_id } : null };
}

async function walletForVerifiedIdentity(
  client: PoolClient,
  params: { appId: string; email: string; rootOrganizationId: string }
): Promise<{ person: PersonRow; wallet: EmailWalletRow | null } | null> {
  const identity = await getIdentity(client, { appId: params.appId, kind: "email", subject: params.email.trim().toLowerCase() });
  if (!identity?.verified_at) return null;
  const person = await getPerson(client, { appId: params.appId, userId: identity.user_id });
  if (!person) throw new Error("Verified email identity has no person");
  const resources = await listTurnkeyResourcesForUserForApp(client, { appId: params.appId, userId: person.id });
  const wallet = selectSignInWallet(resources, params.rootOrganizationId);
  return { person, wallet: wallet ? { ...wallet, external_user_id: person.external_user_id } : null };
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

      const verification = readVerification(verificationToken);
      const email = verification.contact;
      if (hashEmailForRateLimit(email) !== challenge.email_hash) {
        throw new Error("Turnkey verified a different email than this challenge was sent to");
      }

      // ponytail: the transaction holds a pool connection through a
      // Turnkey create (up to its 30 s activity poll), so a replica runs at
      // most pool-size first sign-ins at once. If bursts outgrow that,
      // commit a claim row under a short lock and have waiters poll it.
      const orphanedSubOrg: { current: { subOrganizationId: string; walletId: string; activityId: string } | null } = {
        current: null
      };
      let wallet: EmailWalletRow;
      let attested: {
        sessionToken: string;
        sessionExpiresAt: string;
        idToken: string;
        idTokenExpiresAt: string;
        email: string;
        emailVerified: boolean;
      };
      try {
        ({ row: wallet, attested } = await withDbTransaction(db, async (client) => {
          await lockEmailWallets(client, { appId, email });
          let row = await findEmailWalletByVerifiedEmail(client, { appId, email });
          let created = false;
          const alreadyPinned = row !== null;
          if (!row) {
            const rootOrganizationId = server.config.TURNKEY_ORGANIZATION_ID;
            // A verified primary wins, then a verified email identity whose
            // primary was never set. An unverified backfill identity does
            // not: it is the oldest recovery_email, which was never proved.
            const verified =
              (await findVerifiedPersonWallet(client, { appId, email, rootOrganizationId })) ??
              (await walletForVerifiedIdentity(client, { appId, email, rootOrganizationId }));
            row = verified?.wallet ?? (verified ? null : await findEmailWalletByRecoveryEmail(client, { appId, email, rootOrganizationId }));
            if (!row) {
              const person = verified?.person ?? (await createPerson(client, { appId, email, emailVerified: true }));
              row = await createEmailWallet(client, {
                appId,
                person,
                email,
                network: networkDefaults(request.headers["x-network"] as string | undefined),
                log: request.log,
                onSubOrgCreated: (createdOrg) => {
                  orphanedSubOrg.current = createdOrg;
                }
              });
              created = true;
            }
            await pinVerifiedEmail(client, { appId, resourceId: row.id, email });
          }
          // A wallet that is already this email's sign-in stays that way.
          // A pin written in this transaction must also get the identity and
          // the verified primary; otherwise the transaction rolls back.
          let identityOk = true;
          try {
            const claim = await claimEmailIdentity(client, { appId, userId: row.user_id!, email });
            identityOk = claim.ok;
          } catch (err) {
            if (!alreadyPinned) throw err;
            identityOk = false;
            request.log.error(
              { appId, userId: row.user_id, err: String((err as { message?: string })?.message ?? err) },
              "recovery.signin.identity_claim_failed"
            );
          }
          const primaryWritten = await setVerifiedPrimaryEmail(client, { appId, userId: row.user_id!, email });
          if (!alreadyPinned && (!identityOk || !primaryWritten)) {
            throw new Error("Verified email identity belongs to another person");
          }
          const person = await getPerson(client, { appId, userId: row.user_id! });
          if (!person) throw new Error("Email wallet's user no longer exists");
          const emailVerified = person.email_verified_at !== null;
          const session = await mintSessionForUser(client, { appId, userId: person.id });
          const idToken = await mintIdentityToken(client, server.idTokenSigner, {
            appId,
            userId: person.id,
            externalUserId: person.external_user_id ?? person.id,
            email: person.primary_email ?? email,
            emailVerified,
            amr: ["email"]
          });
          const candidate = toCandidate(row);
          candidate.verificationTokenId = verification.tokenId;
          await updateRecoveryChallengeCandidates(client, { id: challenge.id, candidates: [candidate] });
          // The code's 10-minute window started at /signin. Session has until
          // the verification token itself expires, which is measured from verify.
          await markRecoveryChallengeStatus(client, {
            id: challenge.id,
            status: "consumed",
            expiresAt: new Date(verification.expiresAtMs)
          });
          await audit(client, "succeeded", { resourceId: row.id, created, sessionId: session.sessionId, emailVerified }, row.user_id);
          return {
            row,
            attested: {
              sessionToken: session.token,
              sessionExpiresAt: session.expiresAt,
              idToken: idToken.token,
              idTokenExpiresAt: idToken.expiresAt,
              email: person.primary_email ?? email,
              emailVerified
            }
          };
        }));
      } catch (err) {
        if (orphanedSubOrg.current) {
          const orphan = orphanedSubOrg.current;
          request.log.error(
            { appId, ...orphan, err: String((err as { message?: string })?.message ?? err) },
            "recovery.signin.suborg_orphaned"
          );
          try {
            await withDbTransaction(db, (client) =>
              audit(client, "failed", { reason: "suborg_orphaned", ...orphan })
            );
          } catch (auditErr) {
            request.log.error(
              { appId, err: String((auditErr as { message?: string })?.message ?? auditErr) },
              "recovery.signin.suborg_orphaned_audit_failed"
            );
          }
        }
        throw err;
      }

      return {
        verificationToken,
        organizationId: wallet.organization_id,
        rootUserId: wallet.turnkey_root_user_id,
        walletId: wallet.wallet_id,
        defaultAddress: wallet.default_address,
        defaultPublicKeyHex: wallet.default_public_key_hex,
        externalUserId: wallet.external_user_id,
        // Always email: the client finishes with /signin/session even when the
        // wallet was first opened with Google. authMethod here is the bootstrap,
        // not the sub-org's original method.
        authMethod: "email" as const,
        ...attested
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
      if (!challenge?.otp_id || challenge.status !== "consumed" || !(Date.parse(challenge.expires_at) > Date.now())) {
        return reply.unauthorized("Sign-in expired; request a new code");
      }
      const wallet = challenge.candidates[0];
      if (!wallet) return reply.unauthorized("Sign-in expired; request a new code");
      if (body.publicKey !== body.clientSignature.publicKey) {
        return reply.unauthorized("Invalid verification");
      }
      let presented: OtpVerification;
      try {
        presented = readVerification(body.verificationToken);
      } catch {
        return reply.unauthorized("Invalid verification");
      }
      // Parent-issued tokens are not scoped to one sub-org. The signature
      // proves the key bound into the token, so the contact and token id
      // have to be this challenge's or a different inbox's token would open it.
      if (
        hashEmailForRateLimit(presented.contact) !== challenge.email_hash ||
        presented.tokenId !== wallet.verificationTokenId ||
        (presented.publicKey !== null && presented.publicKey !== body.publicKey) ||
        presented.expiresAtMs <= Date.now()
      ) {
        return reply.unauthorized("Invalid verification");
      }

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
