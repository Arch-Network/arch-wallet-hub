/**
 * POST /recovery/email/signin -- email get-or-create without an
 * existence oracle.
 *
 *   POST /recovery/email/signin  { email, walletName? }
 *     ├─ rate-limit by sha256(email), shared with /init
 *     ├─ look up the app's existing OTP-capable email wallet for the
 *     │  email; if none, create an email sub-org wallet for a fresh
 *     │  Hub user with a server-generated externalUserId
 *     ├─ persist a single-candidate recovery_challenges row
 *     └─ returns { challengeId, candidateToken, emailMasked, expiresAt }
 *
 * The client then runs the unchanged /recovery/email/start and
 * /recovery/email/verify steps. Only /verify, after OTP_AUTH succeeds
 * for this exact email, reveals the wallet (existing or new).
 *
 * SECURITY: the response must be identical whether or not a wallet
 * already existed -- same status, same keys, no ids or addresses, and
 * a padded minimum latency so the Turnkey create on the "new" path is
 * not a timing signal. The caller's own externalUserId is deliberately
 * not accepted: attaching the new wallet to it pre-verification would
 * make GET /turnkey/wallets an existence oracle, and touching an
 * existing user without that user's session would bypass
 * requireSessionForExistingUser.
 */

import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { withDbTransaction } from "../db/tx.js";
import { getDbPool } from "../db/pool.js";
import { getOrCreateUserByExternalId, updateUserRecoveryEmail } from "../db/apps.js";
import {
  findEmailWalletByRecoveryEmail,
  insertTurnkeyResource,
  type EmailWalletRow
} from "../db/queries.js";
import {
  computeCandidateToken,
  countRecentChallenges,
  hashEmailForRateLimit,
  insertRecoveryChallenge,
  maskAddress,
  maskEmail,
  updateRecoveryChallengeCandidates,
  type RecoveryCandidate
} from "../db/recovery.js";
import { getTurnkeyClient } from "../turnkey/store.js";
import { auditEvent } from "../audit/audit.js";
import { padToMinimumDuration } from "../recovery/responseFloor.js";

// Must exceed the typical Turnkey CREATE_SUB_ORGANIZATION + wallet
// accounts round trip so both paths return after the same delay.
export const SIGNIN_MIN_RESPONSE_MS = 4000;

const SigninBody = Type.Object({
  email: Type.String({ format: "email" }),
  walletName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 }))
});

const SigninResponse = Type.Object({
  challengeId: Type.String(),
  candidateToken: Type.String(),
  emailMasked: Type.String(),
  expiresAt: Type.String()
});

export type SigninLimits = {
  maxPerWindow: number;
  windowMs: number;
  challengeTtlMs: number;
};

type NetworkDefaults = { addressFormat: string; derivationPath: string };

function networkDefaults(networkHint: string | undefined): NetworkDefaults {
  return networkHint?.toLowerCase() === "mainnet"
    ? { addressFormat: "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR", derivationPath: "m/86'/0'/0'/0/0" }
    : { addressFormat: "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR", derivationPath: "m/86'/1'/0'/0/0" };
}

async function createEmailWalletForNewUser(params: {
  appId: string;
  email: string;
  walletName: string | undefined;
  network: NetworkDefaults;
  log: { warn: (obj: object, msg: string) => void };
}): Promise<EmailWalletRow> {
  const db = getDbPool();
  const externalUserId = `email-${randomUUID()}`;
  const user = await withDbTransaction(db, async (client) => {
    const u = await getOrCreateUserByExternalId(client, { appId: params.appId, externalUserId });
    await updateUserRecoveryEmail(client, { appId: params.appId, userId: u.id, email: params.email });
    return u;
  });

  const turnkey = getTurnkeyClient() as any;
  const created = await turnkey.createSubOrganizationWithEmailWallet({
    subOrganizationName: `arch-${params.appId}-${externalUserId}-email`,
    rootUser: { userName: externalUserId, userEmail: params.email },
    wallet: {
      walletName: params.walletName ?? `arch-embedded-${user.id.slice(0, 8)}-${Date.now().toString(36)}`,
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

  const resource = await withDbTransaction(db, (client) =>
    insertTurnkeyResource(client, {
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
    })
  );
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

export function registerEmailSigninRoute(server: FastifyInstance, limits: SigninLimits) {
  server.post(
    "/recovery/email/signin",
    {
      schema: {
        summary:
          "Email sign-in: get-or-create the app's email wallet for this email, revealed only after OTP verify",
        tags: ["recovery"],
        body: SigninBody,
        response: { 200: SigninResponse }
      }
    },
    async (request, reply) => {
      const startedAtMs = Date.now();
      const appId = (request as any).app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const db = getDbPool();
      const body = request.body as typeof SigninBody.static;
      const email = body.email.trim();
      const emailHash = hashEmailForRateLimit(email);

      // Counts depend only on how often this email was asked about, not
      // on whether it has a wallet, so an explicit 429 is not an oracle.
      const recentCount = await withDbTransaction(db, (client) =>
        countRecentChallenges(client, { appId, emailHash, windowMs: limits.windowMs })
      );
      if (recentCount >= limits.maxPerWindow) {
        request.log.warn({ appId, emailHash, recentCount }, "recovery.signin.rate_limited");
        return reply.tooManyRequests("Too many sign-in attempts for this email; try again later");
      }

      const existing = await withDbTransaction(db, (client) =>
        findEmailWalletByRecoveryEmail(client, {
          appId,
          email,
          rootOrganizationId: server.config.TURNKEY_ORGANIZATION_ID
        })
      );
      const target =
        existing ??
        (await createEmailWalletForNewUser({
          appId,
          email,
          walletName: body.walletName,
          network: networkDefaults(request.headers["x-network"] as string | undefined),
          log: request.log
        }));

      if (!target.turnkey_root_user_id) {
        throw new Error("Turnkey did not return a root user for the new email sub-org");
      }

      const challenge = await withDbTransaction(db, async (client) => {
        const row = await insertRecoveryChallenge(client, {
          appId,
          emailHash,
          candidates: [toCandidate(target)],
          ttlMs: limits.challengeTtlMs
        });
        const candidateToken = computeCandidateToken(row.id, target.id);
        await updateRecoveryChallengeCandidates(client, {
          id: row.id,
          candidates: [{ ...toCandidate(target), candidateToken }]
        });
        await auditEvent({
          client,
          appId,
          requestId: request.id,
          userId: target.user_id,
          eventType: "recovery.signin",
          entityType: "recovery_challenge",
          entityId: row.id,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: { emailHash, candidateResourceId: target.id, reused: Boolean(existing) },
          outcome: "succeeded"
        });
        return { id: row.id, expiresAt: row.expires_at, candidateToken };
      });

      await padToMinimumDuration(startedAtMs, SIGNIN_MIN_RESPONSE_MS);
      return {
        challengeId: challenge.id,
        candidateToken: challenge.candidateToken,
        emailMasked: maskEmail(email),
        expiresAt: challenge.expiresAt
      };
    }
  );
}
