import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { withDbTransaction } from "../db/tx.js";
import { getDbPool } from "../db/pool.js";
import { getTurnkeyClient } from "../turnkey/store.js";
import {
  getTurnkeyResourceByIdForApp,
  insertTurnkeyResource,
  listTurnkeyResourcesForUserForApp,
  markIdempotencyFailed,
  markIdempotencySucceeded
} from "../db/queries.js";
import {
  getOrCreateUserByExternalId,
  getUserByExternalId,
  updateUserRecoveryEmail
} from "../db/apps.js";
import {
  computeRequestHash,
  consumeIdempotencyKey,
  sha256Hex
} from "../idempotency/idempotency.js";
import { auditEvent } from "../audit/audit.js";
import {
  computeBip322ToSignTaprootSighash
} from "../bitcoin/bip322.js";

const CreateWalletBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  walletName: Type.Optional(Type.String({ minLength: 1 })),
  addressFormat: Type.Optional(Type.String({ minLength: 1 })),
  derivationPath: Type.Optional(Type.String({ minLength: 1 })),
  // Phase 1.10: recovery email captured at sign-up. Stored in the
  // sub-org so future OTP recovery flows know where to send the code.
  userEmail: Type.Optional(Type.String({ format: "email" })),
});

const CreatePasskeyWalletBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  walletName: Type.Optional(Type.String({ minLength: 1 })),
  addressFormat: Type.Optional(Type.String({ minLength: 1 })),
  derivationPath: Type.Optional(Type.String({ minLength: 1 })),
  userEmail: Type.Optional(Type.String({ format: "email" })),
  passkey: Type.Object({
    challenge: Type.String({ minLength: 1 }), // base64url
    attestation: Type.Unknown()
  })
});

// Email-only sub-org wallet. The root user is created without any
// authenticators or API keys; bootstrap happens later via the
// `/recovery/email/{init,verify}` flow which mints a 15-minute API
// key the client decrypts and uses to register a permanent
// IndexedDB-stored credential.
const CreateEmailWalletBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  // userEmail is REQUIRED here -- you can't recover an email wallet
  // if we don't know which inbox to send the OTP to.
  userEmail: Type.String({ format: "email", minLength: 3 }),
  walletName: Type.Optional(Type.String({ minLength: 1 })),
  addressFormat: Type.Optional(Type.String({ minLength: 1 })),
  derivationPath: Type.Optional(Type.String({ minLength: 1 })),
});

const ImportPasskeyWalletBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  organizationId: Type.String({ minLength: 1 }),
  defaultAddress: Type.String({ minLength: 1 }),
  defaultPublicKeyHex: Type.String({ minLength: 64 }),
  label: Type.Optional(Type.String({ minLength: 1 }))
});

const CreateWalletResponse = Type.Object({
  resourceId: Type.String(),
  userId: Type.String(),
  externalUserId: Type.String(),
  organizationId: Type.String(),
  walletId: Type.String(),
  addresses: Type.Array(Type.String()),
  defaultAddress: Type.Union([Type.String(), Type.Null()]),
  defaultPublicKeyHex: Type.Union([Type.String(), Type.Null()]),
  activityId: Type.String()
});

const ImportPasskeyWalletResponse = Type.Object({
  resourceId: Type.String(),
  userId: Type.String(),
  externalUserId: Type.String(),
  organizationId: Type.String(),
  defaultAddress: Type.String(),
  defaultPublicKeyHex: Type.String()
});

const GetWalletResponse = Type.Object({
  id: Type.String(),
  userId: Type.Union([Type.String(), Type.Null()]),
  externalUserId: Type.Union([Type.String(), Type.Null()]),
  organizationId: Type.String(),
  turnkeyRootUserId: Type.Union([Type.String(), Type.Null()]),
  walletId: Type.Union([Type.String(), Type.Null()]),
  defaultAddress: Type.Union([Type.String(), Type.Null()]),
  defaultPublicKeyHex: Type.Union([Type.String(), Type.Null()]),
  defaultAddressFormat: Type.Union([Type.String(), Type.Null()]),
  defaultDerivationPath: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  /**
   * @deprecated Server-side signing is gone; this field is always
   *             true only for legacy parent-org rows that pre-date
   *             the migration. New clients should branch on
   *             {@link authMethod} instead.
   */
  isCustodial: Type.Boolean(),
  /**
   * Discriminator the recovery + session bootstrap flows pivot on.
   *   - "passkey": sub-org with WebAuthn authenticators registered.
   *   - "email":   sub-org with API keys only; requires OTP per
   *                session bootstrap.
   *   - null:      legacy parent-org row from the deprecated
   *                custodial model.
   */
  authMethod: Type.Union([
    Type.Literal("passkey"),
    Type.Literal("email"),
    Type.Null()
  ])
});

const ListWalletsResponse = Type.Object({
  externalUserId: Type.String(),
  userId: Type.Union([Type.String(), Type.Null()]),
  wallets: Type.Array(GetWalletResponse)
});

const SignMessageBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  resourceId: Type.String({ minLength: 1 }),
  message: Type.String({ minLength: 1 }),
  encoding: Type.Optional(
    Type.Union([
      Type.Literal("PAYLOAD_ENCODING_TEXT_UTF8"),
      Type.Literal("PAYLOAD_ENCODING_HEXADECIMAL")
    ])
  ),
  hashFunction: Type.Optional(
    Type.Union([Type.Literal("HASH_FUNCTION_NO_OP"), Type.Literal("HASH_FUNCTION_SHA256")])
  )
});

const SignMessageResponse = Type.Object({
  resourceId: Type.String(),
  signedWith: Type.String(),
  activityId: Type.String(),
  signature64Hex: Type.String()
});

export const registerTurnkeyRoutes: FastifyPluginAsync = async (server) => {
  server.post(
    "/turnkey/passkey-wallets/import",
    {
      preHandler: server.enforceSessionForRoute("turnkey.passkey-wallets.import"),
      schema: {
        summary: "Register an existing passkey wallet metadata row for this Hub app",
        tags: ["turnkey"],
        body: ImportPasskeyWalletBody,
        response: { 200: ImportPasskeyWalletResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const body = request.body as any;
      const externalUserId = String(body.externalUserId);
      const organizationId = String(body.organizationId);
      const defaultAddress = String(body.defaultAddress);
      const defaultPublicKeyHex = String(body.defaultPublicKeyHex);
      const db = getDbPool();

      const response = await withDbTransaction(db, async (client) => {
        const user = await getOrCreateUserByExternalId(client, { appId, externalUserId });
        const resource = await insertTurnkeyResource(client, {
          appId,
          userId: user.id,
          organizationId,
          turnkeyRootUserId: null,
          walletId: null,
          vaultId: null,
          keyId: null,
          policyId: null,
          defaultAddress,
          defaultPublicKeyHex,
          defaultAddressFormat: null,
          defaultDerivationPath: null,
          // Import path is only reachable for sub-org passkey wallets
          // (custodial parent-org "imports" were never supported).
          authMethod: "passkey"
        });

        await auditEvent({
          client,
          appId,
          requestId: request.id,
          userId: user.id,
          eventType: "turnkey.wallet.import",
          entityType: "turnkey_resource",
          entityId: resource.id,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: {
            mode: "passkey_metadata_import",
            organizationId,
            defaultAddress,
            label: body.label ?? null
          },
          outcome: "succeeded"
        });

        return {
          resourceId: resource.id,
          userId: user.id,
          externalUserId,
          organizationId,
          defaultAddress,
          defaultPublicKeyHex
        };
      });

      return response;
    }
  );

  server.post(
    "/turnkey/passkey-wallets",
    {
      preHandler: server.enforceSessionForRoute("turnkey.passkey-wallets.create"),
      schema: {
        summary: "Create a non-custodial embedded wallet (sub-org + passkey root user + wallet)",
        tags: ["turnkey"],
        body: CreatePasskeyWalletBody,
        response: { 200: CreateWalletResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const idempotencyKey = request.headers["idempotency-key"]?.toString();
      if (!idempotencyKey) return reply.badRequest("Missing Idempotency-Key header");

      const body = request.body as any;
      const route = "POST /v1/turnkey/passkey-wallets";
      const requestHash = computeRequestHash(body);

      const db = getDbPool();
      const consumed = await withDbTransaction(db, async (client) => {
        const res = await consumeIdempotencyKey({
          client,
          appId,
          key: idempotencyKey,
          route,
          requestHash
        });

        if (res.kind !== "created") return res;
        const externalUserId = (body as any).externalUserId;
        const userEmail = (body as any).userEmail;
        const user = await getOrCreateUserByExternalId(client, { appId, externalUserId });
        // Phase 1.10: persist the recovery email at sign-up so the
        // /recovery/email/init endpoint can resolve this user without
        // trusting client-supplied email values at recovery time.
        if (typeof userEmail === "string" && userEmail.trim().length > 0) {
          await updateUserRecoveryEmail(client, {
            appId,
            userId: user.id,
            email: userEmail
          });
        }
        return { ...res, userId: user.id };
      });

      if (consumed.kind === "replayed") return consumed.response;
      if (consumed.kind === "conflict") return reply.conflict(consumed.reason);
      if (consumed.kind === "in_progress") return reply.conflict(consumed.reason);
      if (consumed.kind === "failed") return reply.code(409).send({ message: consumed.reason, error: consumed.error });

      const userId = (consumed as { userId: string }).userId;
      const externalUserId = (body as any).externalUserId;
      const userEmail = (body as any).userEmail;
      const walletName = (body as any).walletName ?? `arch-embedded-${userId.slice(0, 8)}-${Date.now().toString(36)}`;
      const networkHint = (request.headers["x-network"] as string)?.toLowerCase();
      const isMainnet = networkHint === "mainnet";
      const addressFormat = (body as any).addressFormat ??
        (isMainnet ? "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR" : "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR");
      const derivationPath = (body as any).derivationPath ??
        (isMainnet ? "m/86'/0'/0'/0/0" : "m/86'/1'/0'/0/0");

      await withDbTransaction(db, async (client) => {
        await auditEvent({
          client,
          appId,
          requestId: request.id,
          userId,
          eventType: "turnkey.wallet.create",
          entityType: "user",
          entityId: userId,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: {
            mode: "passkey_suborg",
            walletName,
            addressFormat,
            derivationPath
          },
          outcome: "requested"
        });
      });

      try {
        const turnkey = getTurnkeyClient();
        const subOrganizationName = `arch-${appId}-${externalUserId}`;
        const created = await (turnkey as any).createSubOrganizationWithWallet({
          subOrganizationName,
          rootUser: {
            userName: String(externalUserId),
            // Forward the email to Turnkey so the sub-org has it on
            // file -- INIT_OTP_AUTH later targets the email recorded
            // against the root user, not our Hub-side mirror.
            userEmail:
              typeof userEmail === "string" && userEmail.trim().length > 0
                ? userEmail.trim()
                : undefined,
            passkey: {
              challenge: String((body as any).passkey.challenge),
              attestation: (body as any).passkey.attestation
            }
          },
          wallet: {
            walletName,
            addressFormat,
            path: derivationPath
          }
        });

        const defaultAddress = created.addresses[0] ?? null;
        let defaultPublicKeyHex: string | null = null;
        try {
          const accountsRes = await (turnkey as any).getWalletAccountsForOrganization({
            organizationId: created.subOrganizationId,
            walletId: created.walletId
          });
          const accounts = Array.isArray(accountsRes?.accounts) ? accountsRes.accounts : [];
          const match = defaultAddress ? accounts.find((a: any) => a?.address === defaultAddress) : null;
          defaultPublicKeyHex = typeof match?.publicKey === "string" ? match.publicKey : null;
        } catch (e: any) {
          request.log.warn(
            { err: String(e?.message ?? e), orgId: created.subOrganizationId, walletId: created.walletId },
            "Failed to fetch Turnkey wallet accounts (suborg) for default public key"
          );
        }

        const response = await withDbTransaction(db, async (client) => {
          const resource = await insertTurnkeyResource(client, {
            appId,
            userId,
            organizationId: created.subOrganizationId,
            turnkeyRootUserId: created.rootUserId ?? null,
            walletId: created.walletId,
            vaultId: null,
            keyId: null,
            policyId: null,
            defaultAddress,
            defaultPublicKeyHex,
            defaultAddressFormat: addressFormat,
            defaultDerivationPath: derivationPath,
            // Sub-org-with-authenticators creation path.
            authMethod: "passkey"
          });

          await auditEvent({
            client,
            appId,
            requestId: request.id,
            userId,
            eventType: "turnkey.wallet.create",
            entityType: "turnkey_resource",
            entityId: resource.id,
            turnkeyActivityId: created.activityId,
            turnkeyRequestId: null,
            payloadJson: {
              mode: "passkey_suborg",
              subOrganizationId: created.subOrganizationId,
              rootUserId: created.rootUserId,
              walletId: created.walletId,
              addresses: created.addresses,
              defaultAddress
            },
            outcome: "succeeded"
          });

          const responseBody = {
            resourceId: resource.id,
            userId,
            externalUserId,
            organizationId: created.subOrganizationId,
            walletId: created.walletId,
            addresses: created.addresses,
            defaultAddress,
            defaultPublicKeyHex,
            activityId: created.activityId
          };

          await markIdempotencySucceeded(client, consumed.row.id, responseBody);
          return responseBody;
        });

        return response;
      } catch (err: any) {
        await withDbTransaction(db, async (client) => {
          await auditEvent({
            client,
            appId,
            requestId: request.id,
            userId,
            eventType: "turnkey.wallet.create",
            entityType: "user",
            entityId: userId,
            turnkeyActivityId: null,
            turnkeyRequestId: null,
            payloadJson: { error: String(err?.message ?? err) },
            outcome: "failed"
          });
          await markIdempotencyFailed(client, consumed.row.id, { message: String(err?.message ?? err) });
        });
        throw err;
      }
    }
  );

  // P1 -- email-only sub-org wallet creation. The created sub-org has
  // no authenticators and no API keys; the client bootstraps a
  // session-grade IndexedDB credential later via OTP_AUTH. The Hub
  // never receives or stores a long-lived signing key for this
  // user. Idempotency, audit, and persistence semantics mirror
  // /turnkey/passkey-wallets verbatim so the operational/runbook
  // story is identical.
  server.post(
    "/turnkey/email-wallets",
    {
      preHandler: server.enforceSessionForRoute("turnkey.email-wallets.create"),
      schema: {
        summary:
          "Create a non-custodial email-only embedded wallet (sub-org + email root user + wallet)",
        tags: ["turnkey"],
        body: CreateEmailWalletBody,
        response: { 200: CreateWalletResponse },
      },
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const idempotencyKey = request.headers["idempotency-key"]?.toString();
      if (!idempotencyKey)
        return reply.badRequest("Missing Idempotency-Key header");

      const body = request.body as any;
      const route = "POST /v1/turnkey/email-wallets";
      const requestHash = computeRequestHash(body);

      const db = getDbPool();
      const consumed = await withDbTransaction(db, async (client) => {
        const res = await consumeIdempotencyKey({
          client,
          appId,
          key: idempotencyKey,
          route,
          requestHash,
        });
        if (res.kind !== "created") return res;

        const externalUserId = body.externalUserId;
        const userEmail = body.userEmail;
        const user = await getOrCreateUserByExternalId(client, {
          appId,
          externalUserId,
        });
        await updateUserRecoveryEmail(client, {
          appId,
          userId: user.id,
          email: userEmail,
        });
        return { ...res, userId: user.id };
      });

      if (consumed.kind === "replayed") return consumed.response;
      if (consumed.kind === "conflict") return reply.conflict(consumed.reason);
      if (consumed.kind === "in_progress")
        return reply.conflict(consumed.reason);
      if (consumed.kind === "failed")
        return reply
          .code(409)
          .send({ message: consumed.reason, error: consumed.error });

      const userId = (consumed as { userId: string }).userId;
      const externalUserId = body.externalUserId;
      const userEmail = body.userEmail;
      const walletName =
        body.walletName ??
        `arch-embedded-${userId.slice(0, 8)}-${Date.now().toString(36)}`;
      const networkHint = (request.headers["x-network"] as string)?.toLowerCase();
      const isMainnet = networkHint === "mainnet";
      const addressFormat =
        body.addressFormat ??
        (isMainnet
          ? "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR"
          : "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR");
      const derivationPath =
        body.derivationPath ??
        (isMainnet ? "m/86'/0'/0'/0/0" : "m/86'/1'/0'/0/0");

      await withDbTransaction(db, async (client) => {
        await auditEvent({
          client,
          appId,
          requestId: request.id,
          userId,
          eventType: "turnkey.wallet.create",
          entityType: "user",
          entityId: userId,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: {
            mode: "email_suborg",
            walletName,
            addressFormat,
            derivationPath,
          },
          outcome: "requested",
        });
      });

      try {
        const turnkey = getTurnkeyClient();
        const subOrganizationName = `arch-${appId}-${externalUserId}-email`;
        const created = await (turnkey as any).createSubOrganizationWithEmailWallet({
          subOrganizationName,
          rootUser: {
            userName: String(externalUserId),
            userEmail: userEmail.trim(),
          },
          wallet: {
            walletName,
            addressFormat,
            path: derivationPath,
          },
        });

        const defaultAddress: string | null = created.addresses[0] ?? null;
        let defaultPublicKeyHex: string | null = null;
        try {
          const accountsRes = await (
            turnkey as any
          ).getWalletAccountsForOrganization({
            organizationId: created.subOrganizationId,
            walletId: created.walletId,
          });
          const accounts = Array.isArray(accountsRes?.accounts)
            ? accountsRes.accounts
            : [];
          const match = defaultAddress
            ? accounts.find((a: any) => a?.address === defaultAddress)
            : null;
          defaultPublicKeyHex =
            typeof match?.publicKey === "string" ? match.publicKey : null;
        } catch (e: any) {
          request.log.warn(
            {
              err: String(e?.message ?? e),
              orgId: created.subOrganizationId,
              walletId: created.walletId,
            },
            "Failed to fetch Turnkey wallet accounts (email suborg) for default public key",
          );
        }

        const response = await withDbTransaction(db, async (client) => {
          const resource = await insertTurnkeyResource(client, {
            appId,
            userId,
            organizationId: created.subOrganizationId,
            turnkeyRootUserId: created.rootUserId ?? null,
            walletId: created.walletId,
            vaultId: null,
            keyId: null,
            policyId: null,
            defaultAddress,
            defaultPublicKeyHex,
            defaultAddressFormat: addressFormat,
            defaultDerivationPath: derivationPath,
            // Email-only sub-org: no authenticator, recovery happens
            // via OTP-derived API key bootstrap.
            authMethod: "email",
          });

          await auditEvent({
            client,
            appId,
            requestId: request.id,
            userId,
            eventType: "turnkey.wallet.create",
            entityType: "turnkey_resource",
            entityId: resource.id,
            turnkeyActivityId: created.activityId,
            turnkeyRequestId: null,
            payloadJson: {
              mode: "email_suborg",
              subOrganizationId: created.subOrganizationId,
              rootUserId: created.rootUserId,
              walletId: created.walletId,
              addresses: created.addresses,
              defaultAddress,
            },
            outcome: "succeeded",
          });

          const responseBody = {
            resourceId: resource.id,
            userId,
            externalUserId,
            organizationId: created.subOrganizationId,
            walletId: created.walletId,
            addresses: created.addresses,
            defaultAddress,
            defaultPublicKeyHex,
            activityId: created.activityId,
          };

          await markIdempotencySucceeded(client, consumed.row.id, responseBody);
          return responseBody;
        });

        return response;
      } catch (err: any) {
        await withDbTransaction(db, async (client) => {
          await auditEvent({
            client,
            appId,
            requestId: request.id,
            userId,
            eventType: "turnkey.wallet.create",
            entityType: "user",
            entityId: userId,
            turnkeyActivityId: null,
            turnkeyRequestId: null,
            payloadJson: { error: String(err?.message ?? err) },
            outcome: "failed",
          });
          await markIdempotencyFailed(client, consumed.row.id, {
            message: String(err?.message ?? err),
          });
        });
        throw err;
      }
    },
  );

  // ── Removed in P4: POST /turnkey/wallets ───────────────────────────
  // Created a wallet directly inside the Hub's parent Turnkey org.
  // That model leaked custodial keys into the Hub's blast radius;
  // every wallet now lives in its own sub-org with no Hub access to
  // signing material. New wallets are created via POST
  // /turnkey/passkey-wallets or POST /turnkey/email-wallets. Listing
  // legacy parent-org rows is still possible via the GET routes
  // below; recovery filters them out (they predate the new model
  // and can't be re-bound to a sub-org session).

  server.get(
    "/turnkey/wallets",
    {
      preHandler: server.enforceSessionForRoute("turnkey.wallets.list"),
      schema: {
        summary: "List stored Turnkey wallet resources for a user",
        tags: ["turnkey"],
        querystring: Type.Object({ externalUserId: Type.String({ minLength: 1 }) }),
        response: { 200: ListWalletsResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const { externalUserId } = request.query as any;
      const db = getDbPool();
      const user = await withDbTransaction(db, (client) =>
        getUserByExternalId(client, { appId, externalUserId })
      );
      if (!user) return { externalUserId, userId: null, wallets: [] };

      const rows = await withDbTransaction(db, (client) =>
        listTurnkeyResourcesForUserForApp(client, { appId, userId: user.id })
      );

      const rootOrgId = server.config.TURNKEY_ORGANIZATION_ID;
      return {
        externalUserId,
        userId: user.id,
        wallets: rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          externalUserId,
          organizationId: row.organization_id,
          turnkeyRootUserId: (row as any).turnkey_root_user_id ?? null,
          walletId: row.wallet_id,
          defaultAddress: row.default_address,
          defaultPublicKeyHex: (row as any).default_public_key_hex ?? null,
          defaultAddressFormat: row.default_address_format,
          defaultDerivationPath: row.default_derivation_path,
          createdAt: row.created_at,
          isCustodial: row.organization_id === rootOrgId,
          authMethod: row.auth_method ?? null
        }))
      };
    }
  );

  server.get(
    "/turnkey/wallets/:resourceId",
    {
      preHandler: server.enforceSessionForRoute("turnkey.wallets.get"),
      schema: {
        summary: "Get stored Turnkey wallet resource metadata",
        tags: ["turnkey"],
        params: Type.Object({ resourceId: Type.String() }),
        querystring: Type.Object({ externalUserId: Type.String({ minLength: 1 }) }),
        response: { 200: GetWalletResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const { resourceId } = request.params as any;
      const { externalUserId } = request.query as any;
      const db = getDbPool();
      const user = await withDbTransaction(db, (client) =>
        getUserByExternalId(client, { appId, externalUserId })
      );
      if (!user) return reply.notFound("Unknown externalUserId");
      const row = await withDbTransaction(db, (client) =>
        getTurnkeyResourceByIdForApp(client, { id: resourceId, appId })
      );
      if (!row) return reply.notFound();
      if (row.user_id !== user.id) return reply.forbidden("Resource does not belong to user");

      const rootOrgId = server.config.TURNKEY_ORGANIZATION_ID;
      return {
        id: row.id,
        userId: row.user_id,
        externalUserId,
        organizationId: row.organization_id,
        turnkeyRootUserId: (row as any).turnkey_root_user_id ?? null,
        walletId: row.wallet_id,
        defaultAddress: row.default_address,
        defaultPublicKeyHex: (row as any).default_public_key_hex ?? null,
        defaultAddressFormat: row.default_address_format,
        defaultDerivationPath: row.default_derivation_path,
        createdAt: row.created_at,
        isCustodial: row.organization_id === rootOrgId,
        authMethod: row.auth_method ?? null
      };
    }
  );

  server.post(
    "/turnkey/sign-message",
    {
      preHandler: server.enforceSessionForRoute("turnkey.sign-message"),
      schema: {
        summary: "Sign a message via Turnkey (Phase 0)",
        tags: ["turnkey"],
        body: SignMessageBody,
        response: { 200: SignMessageResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const idempotencyKey = request.headers["idempotency-key"]?.toString();
      if (!idempotencyKey) {
        return reply.badRequest("Missing Idempotency-Key header");
      }

      const db = getDbPool();
      const body = request.body as any;
      const route = "POST /v1/turnkey/sign-message";
      const requestHash = computeRequestHash(body);

      const consumed = await withDbTransaction(db, async (client) => {
        return await consumeIdempotencyKey({
          client,
          appId,
          key: idempotencyKey,
          route,
          requestHash
        });
      });

      if (consumed.kind === "replayed") return consumed.response;
      if (consumed.kind === "conflict") return reply.conflict(consumed.reason);
      if (consumed.kind === "in_progress") return reply.conflict(consumed.reason);
      if (consumed.kind === "failed")
        return reply.code(409).send({ message: consumed.reason, error: consumed.error });

      const { externalUserId, resourceId, message } = body;
      const encoding = body.encoding ?? "PAYLOAD_ENCODING_TEXT_UTF8";
      const hashFunction = body.hashFunction ?? "HASH_FUNCTION_SHA256";

      const user = await withDbTransaction(db, (client) =>
        getOrCreateUserByExternalId(client, { appId, externalUserId })
      );
      const resource = await withDbTransaction(db, (client) =>
        getTurnkeyResourceByIdForApp(client, { id: resourceId, appId })
      );
      if (!resource) return reply.notFound("Unknown resourceId");
      if (resource.user_id !== user.id) return reply.forbidden("Resource does not belong to user");
      if (!resource.default_address) {
        return reply.badRequest("Resource has no default address to sign with");
      }

      const messageHash = sha256Hex(`${encoding}:${hashFunction}:${message}`);

      await withDbTransaction(db, async (client) => {
        await auditEvent({
          client,
          appId,
          requestId: request.id,
          userId: resource.user_id,
          eventType: "turnkey.sign.message",
          entityType: "turnkey_resource",
          entityId: resourceId,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: { encoding, hashFunction, messageHash },
          outcome: "requested"
        });
      });

      try {
        const turnkey = getTurnkeyClient();
        const sighash = computeBip322ToSignTaprootSighash({
          signerAddress: resource.default_address,
          message
        });

        const signed = await turnkey.signRawPayload({
          signWith: resource.default_address,
          payload: Buffer.from(sighash).toString("hex"),
          encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
          hashFunction: "HASH_FUNCTION_NO_OP"
        });

        const signature64Hex = `${signed.r}${signed.s}`;
        request.log.info(
          { activityId: signed.activityId, resourceId, userId: resource.user_id },
          "turnkey.sign_message.completed"
        );

        const responseBody = await withDbTransaction(db, async (client) => {
          await auditEvent({
            client,
            appId,
            requestId: request.id,
            userId: resource.user_id,
            eventType: "turnkey.sign.message",
            entityType: "turnkey_resource",
            entityId: resourceId,
            turnkeyActivityId: signed.activityId,
            turnkeyRequestId: null,
            // Persist only a hash of the signature in the durable audit
            // row; the raw signature is a sensitive artifact and the
            // hash is sufficient to correlate with the response.
            payloadJson: { signatureSha256: sha256Hex(signature64Hex) },
            outcome: "succeeded"
          });

          const out = {
            resourceId,
            signedWith: resource.default_address,
            activityId: signed.activityId,
            signature64Hex
          };

          await markIdempotencySucceeded(client, consumed.row.id, out);
          return out;
        });

        return responseBody;
      } catch (err: any) {
        await withDbTransaction(db, async (client) => {
          await auditEvent({
            client,
            appId,
            requestId: request.id,
            userId: resource.user_id,
            eventType: "turnkey.sign.message",
            entityType: "turnkey_resource",
            entityId: resourceId,
            turnkeyActivityId: null,
            turnkeyRequestId: null,
            payloadJson: { error: String(err?.message ?? err), messageHash },
            outcome: "failed"
          });
          await markIdempotencyFailed(client, consumed.row.id, {
            message: String(err?.message ?? err)
          });
        });
        throw err;
      }
    }
  );

  // ── Removed in P4: POST /signing/sign-arch-hash ────────────────────
  // Previously signed an arbitrary 32-byte Arch SanitizedMessage hash
  // with a Hub-held custodial key. All swap-side signing now happens
  // client-side via the session-stamped signer; the original handler
  // was deleted along with the parent-org custodial model. See the
  // P4 plan for migration notes.

  server.get(
    "/turnkey/config",
    {
      schema: {
        summary: "Return public Turnkey configuration needed by client-side passkey flows",
        tags: ["turnkey"],
        response: {
          200: Type.Object({
            organizationId: Type.String(),
            apiBaseUrl: Type.String(),
          })
        }
      }
    },
    async () => {
      return {
        organizationId: server.config.TURNKEY_ORGANIZATION_ID,
        apiBaseUrl: "https://api.turnkey.com",
      };
    }
  );
};
