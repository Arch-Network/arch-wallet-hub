/**
 * Social login (Google today; Apple is the same route with a second
 * provider config) and the person it signs in as.
 *
 *   POST /v1/auth/oauth
 *     Body: { provider, oidcToken, publicKey, walletName?, addressFormat?,
 *             derivationPath? }
 *     `publicKey` is the browser's compressed P-256 session key (the
 *     IndexedDB stamper's), and the id token's `nonce` must be
 *     sha256(publicKey). Sign-in and sign-up are one call, as on
 *     Polymarket: an identity the Hub knows opens that person's wallet;
 *     an unknown one creates a person, a Turnkey sub-org whose root user
 *     IS the OIDC identity, and a wallet. Either way the Hub asks Turnkey
 *     to register `publicKey` as a login key (OAUTH_LOGIN) and answers
 *     with the wallet, a Hub session and an Arch ID token.
 *     409 `identity_exists`: the token's VERIFIED email already belongs
 *     to a person this provider is not linked to. The client then runs
 *     the link flow (an OTP code or a passkey proves the existing
 *     account; CREATE_OAUTH_PROVIDERS is stamped from that session), which
 *     is phase 3; until then the person signs in with the email code.
 *
 *   GET  /v1/auth/me            (session)  the person, identities, wallets
 *   POST /v1/auth/id-token      (session)  a fresh Arch ID token
 *   GET  /.well-known/jwks.json (public)   the ID token's public keys
 *
 * Security notes:
 *   - The Hub verifies the id token itself (auth/oidc.ts) before any
 *     Turnkey activity, so `sub`/`email` are trusted for the index and a
 *     bad nonce is a 401 here, not an opaque Turnkey failure.
 *   - Replay: a token is accepted once (`oidc_replay`), for its lifetime.
 *   - The parent API key creates sub-orgs and opens sessions; it holds no
 *     signing authority over them. Same posture as every other route.
 */

import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { withDbTransaction } from "../db/tx.js";
import { getDbPool } from "../db/pool.js";
import { getTurnkeyClient } from "../turnkey/store.js";
import {
  getTurnkeyResourceByIdForApp,
  insertTurnkeyResource,
  listTurnkeyResourcesForUserForApp,
  type TurnkeyResourceRow,
} from "../db/queries.js";
import {
  createPerson,
  getIdentity,
  getPerson,
  getPersonByVerifiedEmail,
  insertIdentity,
  listIdentitiesForUser,
  listWalletPubkeysForUser,
  recordOidcTokenUse,
  setVerifiedPrimaryEmail,
  touchIdentityLogin,
  type IdentityKind,
} from "../db/identities.js";
import { mintSessionForUser } from "../auth/sessionToken.js";
import { GOOGLE_PROVIDER, OidcError, verifyOidcToken, type OidcClaims, type OidcProvider, type OidcProviderConfig } from "../auth/oidc.js";
import { jwksDocument, mintIdToken, type IdTokenSigner } from "../auth/idToken.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Created once in server.ts; shared by this plugin and the root JWKS route. */
    idTokenSigner: IdTokenSigner;
  }
}
import { auditEvent } from "../audit/audit.js";
import { setDefaultRateLimitGroup } from "../plugins/rateLimit.js";

/** Turnkey's own ceiling for a login key opened by the Hub; the clients' IndexedDB key lives this long. */
const SESSION_KEY_TTL_SECONDS = "3600";
const COMPRESSED_P256 = /^0[23][0-9a-f]{64}$/i;

const OAuthBody = Type.Object({
  provider: Type.Literal("google"),
  oidcToken: Type.String({ minLength: 16 }),
  /** Compressed P-256 hex (66 chars): the browser's Turnkey session key. */
  publicKey: Type.String({ minLength: 66, maxLength: 66 }),
  walletName: Type.Optional(Type.String({ minLength: 1 })),
  addressFormat: Type.Optional(Type.String({ minLength: 1 })),
  derivationPath: Type.Optional(Type.String({ minLength: 1 })),
});

const OAuthResponse = Type.Object({
  /** True when this call created the person and their wallet. */
  created: Type.Boolean(),
  externalUserId: Type.String(),
  userId: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  emailVerified: Type.Boolean(),
  resourceId: Type.String(),
  organizationId: Type.String(),
  rootUserId: Type.Union([Type.String(), Type.Null()]),
  walletId: Type.Union([Type.String(), Type.Null()]),
  defaultAddress: Type.Union([Type.String(), Type.Null()]),
  defaultPublicKeyHex: Type.Union([Type.String(), Type.Null()]),
  sessionToken: Type.String(),
  sessionExpiresAt: Type.String(),
  idToken: Type.String(),
  idTokenExpiresAt: Type.String(),
});

const IdentityView = Type.Object({
  id: Type.String(),
  kind: Type.String(),
  /** Masked for email/wallet kinds; OIDC subjects are opaque and returned as-is. */
  subject: Type.String(),
  emailAtLink: Type.Union([Type.String(), Type.Null()]),
  verified: Type.Boolean(),
  createdAt: Type.String(),
  lastLoginAt: Type.Union([Type.String(), Type.Null()]),
});

const WalletView = Type.Object({
  resourceId: Type.String(),
  organizationId: Type.String(),
  authMethod: Type.Union([Type.String(), Type.Null()]),
  defaultAddress: Type.Union([Type.String(), Type.Null()]),
  defaultPublicKeyHex: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

const MeResponse = Type.Object({
  externalUserId: Type.Union([Type.String(), Type.Null()]),
  userId: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  emailVerified: Type.Boolean(),
  identities: Type.Array(IdentityView),
  wallets: Type.Array(WalletView),
});

const IdTokenResponse = Type.Object({
  idToken: Type.String(),
  expiresAt: Type.String(),
});

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(1, Math.min(6, local.length - 1)))}@${domain}`;
}

function maskSubject(kind: IdentityKind, subject: string): string {
  if (kind === "email") return maskEmail(subject);
  if (kind === "wallet") return `${subject.slice(0, 6)}…${subject.slice(-4)}`;
  return subject;
}

export function providerConfigs(env: { GOOGLE_OAUTH_CLIENT_IDS: string }): Record<OidcProvider, OidcProviderConfig> {
  const google = env.GOOGLE_OAUTH_CLIENT_IDS.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return { google: { ...GOOGLE_PROVIDER, clientIds: google } };
}

async function mintIdentityToken(
  signer: IdTokenSigner,
  params: { appId: string; userId: string; externalUserId: string; email: string | null; emailVerified: boolean; amr: string[] },
): Promise<{ token: string; expiresAt: string }> {
  const wallets = await withDbTransaction(getDbPool(), (client) => listWalletPubkeysForUser(client, { appId: params.appId, userId: params.userId }));
  return mintIdToken(signer, {
    sub: params.externalUserId,
    app: params.appId,
    email: params.email,
    email_verified: params.emailVerified,
    wallets,
    amr: params.amr,
  });
}

export const registerAuthOAuthRoutes: FastifyPluginAsync = async (server) => {
  setDefaultRateLimitGroup(server, "auth");

  const signer = server.idTokenSigner;
  const providers = providerConfigs(server.config);

  server.post(
    "/auth/oauth",
    {
      schema: {
        summary: "Sign in or sign up with a social login (OIDC id token bound to the browser's session key)",
        tags: ["auth"],
        body: OAuthBody,
        response: { 200: OAuthResponse },
      },
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const body = request.body as typeof OAuthBody.static;
      const provider = providers[body.provider];
      if (!provider || provider.clientIds.length === 0) {
        return reply.code(503).send({ message: `${body.provider} sign-in is not configured on this Hub` });
      }
      const publicKey = body.publicKey.toLowerCase();
      if (!COMPRESSED_P256.test(publicKey)) return reply.badRequest("publicKey must be a compressed P-256 key (66 hex chars)");

      // 1. The token, on the Hub's own terms.
      let claims: OidcClaims;
      try {
        claims = await verifyOidcToken({ token: body.oidcToken, config: provider, sessionPublicKeyHex: publicKey });
      } catch (err) {
        if (err instanceof OidcError) {
          request.log.warn({ appId, provider: body.provider, code: err.code }, "auth.oauth.token_rejected");
          if (err.code === "jwks_unavailable") return reply.code(503).send({ message: "Identity provider keys are unavailable" });
          return reply.unauthorized(`Invalid id token: ${err.code}`);
        }
        throw err;
      }

      const db = getDbPool();

      // 2. Replay + resolve the person, in one transaction so two racing
      //    sign-ups with the same token cannot both create a person.
      const resolved = await withDbTransaction(db, async (client) => {
        const replay = await recordOidcTokenUse(client, { appId, tokenHash: claims.tokenHash, expiresAt: claims.expiresAt });
        if (replay.replayed) return { kind: "replayed" as const };

        const identity = await getIdentity(client, { appId, kind: claims.provider, subject: claims.subject });
        if (identity) {
          const person = await getPerson(client, { appId, userId: identity.user_id });
          if (!person) return { kind: "orphan" as const };
          const resources = await listTurnkeyResourcesForUserForApp(client, { appId, userId: person.id });
          const resource = resources.find((r) => r.auth_method === "oauth") ?? resources[0] ?? null;
          if (!resource) return { kind: "orphan" as const };
          await touchIdentityLogin(client, { id: identity.id });
          // A Google login vouches for the email: promote it if the person had none verified.
          if (claims.email && claims.emailVerified) {
            await setVerifiedPrimaryEmail(client, { appId, userId: person.id, email: claims.email });
          }
          return { kind: "existing" as const, person, resource };
        }

        if (claims.email && claims.emailVerified) {
          const owner = await getPersonByVerifiedEmail(client, { appId, email: claims.email });
          if (owner) {
            await auditEvent({
              client, appId, requestId: request.id, userId: owner.id,
              eventType: "auth.oauth.identity_collision", entityType: "user", entityId: owner.id,
              turnkeyActivityId: null, turnkeyRequestId: null,
              payloadJson: { provider: claims.provider, audience: claims.audience, emailMasked: maskEmail(claims.email) },
              outcome: "failed",
            });
            return { kind: "collision" as const, owner };
          }
        }
        return { kind: "new" as const };
      });

      if (resolved.kind === "replayed") return reply.unauthorized("Invalid id token: replayed");
      if (resolved.kind === "orphan") return reply.conflict("This identity is linked to a user with no wallet; contact support");
      if (resolved.kind === "collision") {
        return reply.code(409).send({
          code: "identity_exists",
          message: "An Arch account already uses this email. Log in with the email code to link this provider.",
          emailMasked: maskEmail(claims.email!),
        });
      }

      const turnkey = getTurnkeyClient();
      let person: { id: string; external_user_id: string | null; primary_email: string | null; email_verified_at: string | null };
      let resource: TurnkeyResourceRow;
      let created = false;

      if (resolved.kind === "existing") {
        person = resolved.person;
        resource = resolved.resource;
      } else {
        // 3. Sign-up: person + sub-org whose root user is the OIDC identity.
        created = true;
        const networkHint = (request.headers["x-network"] as string | undefined)?.toLowerCase();
        const isMainnet = networkHint === "mainnet";
        const addressFormat = body.addressFormat ?? (isMainnet ? "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR" : "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR");
        const derivationPath = body.derivationPath ?? (isMainnet ? "m/86'/0'/0'/0/0" : "m/86'/1'/0'/0/0");

        person = await withDbTransaction(db, (client) => createPerson(client, { appId, email: claims.email, emailVerified: claims.emailVerified }));
        const walletName = body.walletName ?? `arch-${claims.provider}-${person.id.slice(0, 8)}-${Date.now().toString(36)}`;

        await withDbTransaction(db, (client) =>
          auditEvent({
            client, appId, requestId: request.id, userId: person.id,
            eventType: "turnkey.wallet.create", entityType: "user", entityId: person.id,
            turnkeyActivityId: null, turnkeyRequestId: null,
            payloadJson: { mode: "oauth_suborg", provider: claims.provider, walletName, addressFormat, derivationPath },
            outcome: "requested",
          }),
        );

        let madeSubOrg: Awaited<ReturnType<typeof turnkey.createSubOrganizationWithOAuthWallet>>;
        try {
          madeSubOrg = await turnkey.createSubOrganizationWithOAuthWallet({
            subOrganizationName: `arch-${appId}-${person.external_user_id}-${claims.provider}`,
            rootUser: { userName: claims.email ?? person.external_user_id ?? "arch-user", ...(claims.email ? { userEmail: claims.email } : {}) },
            provider: { providerName: claims.provider, oidcToken: body.oidcToken },
            wallet: { walletName, addressFormat: addressFormat as never, path: derivationPath },
          });
        } catch (err: any) {
          await withDbTransaction(db, (client) =>
            auditEvent({
              client, appId, requestId: request.id, userId: person.id,
              eventType: "turnkey.wallet.create", entityType: "user", entityId: person.id,
              turnkeyActivityId: null, turnkeyRequestId: null,
              payloadJson: { mode: "oauth_suborg", error: String(err?.message ?? err) },
              outcome: "failed",
            }),
          );
          request.log.error({ err: String(err?.message ?? err), appId }, "auth.oauth.suborg_create_failed");
          return reply.code(502).send({ message: "Wallet provider did not complete the account creation" });
        }

        const defaultAddress: string | null = madeSubOrg.addresses[0] ?? null;
        let defaultPublicKeyHex: string | null = null;
        try {
          const accountsRes = await turnkey.getWalletAccountsForOrganization({ organizationId: madeSubOrg.subOrganizationId, walletId: madeSubOrg.walletId });
          const match = defaultAddress ? accountsRes.accounts.find((a) => a.address === defaultAddress) : undefined;
          defaultPublicKeyHex = typeof match?.publicKey === "string" ? match.publicKey : null;
        } catch (e: any) {
          request.log.warn({ err: String(e?.message ?? e), orgId: madeSubOrg.subOrganizationId }, "auth.oauth.wallet_account_lookup_failed");
        }

        resource = await withDbTransaction(db, async (client) => {
          const row = await insertTurnkeyResource(client, {
            appId,
            userId: person.id,
            organizationId: madeSubOrg.subOrganizationId,
            turnkeyRootUserId: madeSubOrg.rootUserId ?? null,
            walletId: madeSubOrg.walletId,
            vaultId: null, keyId: null, policyId: null,
            defaultAddress,
            defaultPublicKeyHex,
            defaultAddressFormat: addressFormat,
            defaultDerivationPath: derivationPath,
            authMethod: "oauth",
            keyVerified: defaultPublicKeyHex !== null,
          });
          await insertIdentity(client, {
            appId, userId: person.id, kind: claims.provider, subject: claims.subject,
            issuer: claims.issuer, audience: claims.audience, emailAtLink: claims.email, verified: true,
          });
          if (claims.email) {
            await insertIdentity(client, {
              appId, userId: person.id, kind: "email", subject: claims.email.toLowerCase(),
              issuer: null, audience: null, emailAtLink: claims.email, verified: claims.emailVerified,
            });
          }
          await auditEvent({
            client, appId, requestId: request.id, userId: person.id,
            eventType: "turnkey.wallet.create", entityType: "turnkey_resource", entityId: row.id,
            turnkeyActivityId: madeSubOrg.activityId, turnkeyRequestId: null,
            payloadJson: { mode: "oauth_suborg", provider: claims.provider, subOrganizationId: madeSubOrg.subOrganizationId, rootUserId: madeSubOrg.rootUserId, walletId: madeSubOrg.walletId, defaultAddress },
            outcome: "succeeded",
          });
          return row;
        });
      }

      // 4. Open the session: Turnkey registers the browser key on the sub-org.
      let activityId: string;
      try {
        const login = await turnkey.oauthLogin({
          organizationId: resource.organization_id,
          oidcToken: body.oidcToken,
          publicKey,
          expirationSeconds: SESSION_KEY_TTL_SECONDS,
        });
        activityId = login.activityId;
      } catch (err: any) {
        await withDbTransaction(db, (client) =>
          auditEvent({
            client, appId, requestId: request.id, userId: person.id,
            eventType: "auth.oauth.login", entityType: "turnkey_resource", entityId: resource.id,
            turnkeyActivityId: null, turnkeyRequestId: null,
            payloadJson: { provider: claims.provider, created, error: String(err?.message ?? err) },
            outcome: "failed",
          }),
        );
        request.log.error({ err: String(err?.message ?? err), appId, resourceId: resource.id }, "auth.oauth.login_failed");
        return reply.code(502).send({ message: "Wallet provider did not open the session" });
      }

      // 5. Hub session + ID token.
      const session = await withDbTransaction(db, async (client) => {
        const minted = await mintSessionForUser(client, { appId, userId: person.id });
        await auditEvent({
          client, appId, requestId: request.id, userId: person.id,
          eventType: "auth.oauth.login", entityType: "turnkey_resource", entityId: resource.id,
          turnkeyActivityId: activityId, turnkeyRequestId: null,
          payloadJson: { provider: claims.provider, created, sessionId: minted.sessionId, audience: claims.audience },
          outcome: "succeeded",
        });
        return minted;
      });
      const fresh = await withDbTransaction(db, (client) => getPerson(client, { appId, userId: person.id }));
      const email = fresh?.primary_email ?? claims.email;
      const emailVerified = fresh?.email_verified_at !== null && fresh?.email_verified_at !== undefined;
      const idToken = await mintIdentityToken(signer, {
        appId, userId: person.id, externalUserId: person.external_user_id ?? person.id, email, emailVerified, amr: [claims.provider],
      });

      return {
        created,
        externalUserId: person.external_user_id ?? person.id,
        userId: person.id,
        email,
        emailVerified,
        resourceId: resource.id,
        organizationId: resource.organization_id,
        rootUserId: resource.turnkey_root_user_id,
        walletId: resource.wallet_id,
        defaultAddress: resource.default_address,
        defaultPublicKeyHex: resource.default_public_key_hex,
        sessionToken: session.token,
        sessionExpiresAt: session.expiresAt,
        idToken: idToken.token,
        idTokenExpiresAt: idToken.expiresAt,
      };
    },
  );

  server.get(
    "/auth/me",
    {
      preHandler: [server.requireSession],
      schema: { summary: "The signed-in person: identities and wallets", tags: ["auth"], response: { 200: MeResponse } },
    },
    async (request, reply) => {
      const principal = request.session;
      if (!principal) return reply.unauthorized("Missing session");
      const { appId, userId } = principal;
      const [person, identities, resources] = await withDbTransaction(getDbPool(), async (client) => [
        await getPerson(client, { appId, userId }),
        await listIdentitiesForUser(client, { appId, userId }),
        await listTurnkeyResourcesForUserForApp(client, { appId, userId }),
      ] as const);
      if (!person) return reply.notFound("Unknown user");
      return {
        externalUserId: person.external_user_id,
        userId: person.id,
        email: person.primary_email,
        emailVerified: person.email_verified_at !== null,
        identities: identities.map((i) => ({
          id: i.id, kind: i.kind, subject: maskSubject(i.kind, i.subject),
          emailAtLink: i.email_at_link ? maskEmail(i.email_at_link) : null,
          verified: i.verified_at !== null, createdAt: i.created_at, lastLoginAt: i.last_login_at,
        })),
        wallets: resources
          .filter((r) => r.organization_id !== server.config.TURNKEY_ORGANIZATION_ID)
          .map((r) => ({
            resourceId: r.id, organizationId: r.organization_id, authMethod: r.auth_method,
            defaultAddress: r.default_address, defaultPublicKeyHex: r.default_public_key_hex, createdAt: r.created_at,
          })),
      };
    },
  );

  server.post(
    "/auth/id-token",
    {
      preHandler: [server.requireSession],
      schema: { summary: "Mint a fresh Arch ID token for the session's person", tags: ["auth"], response: { 200: IdTokenResponse } },
    },
    async (request, reply) => {
      const principal = request.session;
      if (!principal) return reply.unauthorized("Missing session");
      const person = await withDbTransaction(getDbPool(), (client) => getPerson(client, { appId: principal.appId, userId: principal.userId }));
      if (!person) return reply.notFound("Unknown user");
      const minted = await mintIdentityToken(signer, {
        appId: principal.appId, userId: person.id, externalUserId: person.external_user_id ?? person.id,
        email: person.primary_email, emailVerified: person.email_verified_at !== null, amr: ["session"],
      });
      return { idToken: minted.token, expiresAt: minted.expiresAt };
    },
  );

  // Public (plugins/appAuth.ts whitelists it); `/.well-known/jwks.json`
  // at the root is registered by `registerJwksRoute` below, outside the
  // /v1 prefix, for verifiers that discover keys the standard way.
  server.get("/auth/jwks", { schema: { summary: "Arch ID token public keys (JWKS)", tags: ["auth"] } }, async (_request, reply) => {
    reply.header("cache-control", "public, max-age=3600");
    return jwksDocument(signer);
  });

  // The resource a GET /auth/me caller may ask about by id, for the SDK's
  // completeness; not used by the clients today.
  server.get(
    "/auth/wallets/:resourceId",
    { preHandler: [server.requireSession], schema: { summary: "One of the session's wallets", tags: ["auth"], params: Type.Object({ resourceId: Type.String({ format: "uuid" }) }), response: { 200: WalletView } } },
    async (request, reply) => {
      const principal = request.session!;
      const { resourceId } = request.params as { resourceId: string };
      const row = await withDbTransaction(getDbPool(), (client) => getTurnkeyResourceByIdForApp(client, { id: resourceId, appId: principal.appId }));
      if (!row || row.user_id !== principal.userId) return reply.notFound("Unknown wallet");
      return { resourceId: row.id, organizationId: row.organization_id, authMethod: row.auth_method, defaultAddress: row.default_address, defaultPublicKeyHex: row.default_public_key_hex, createdAt: row.created_at };
    },
  );
};

/** `GET /.well-known/jwks.json`, unprefixed. */
export const registerJwksRoute: FastifyPluginAsync = async (server) => {
  server.get("/.well-known/jwks.json", { schema: { summary: "Arch ID token public keys (JWKS)", tags: ["auth"] } }, async (_request, reply) => {
    reply.header("cache-control", "public, max-age=3600");
    return jwksDocument(server.idTokenSigner);
  });
};
