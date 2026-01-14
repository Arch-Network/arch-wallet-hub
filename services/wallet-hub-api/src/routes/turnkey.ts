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
import { getOrCreateUserByExternalId, getUserByExternalId } from "../db/apps.js";
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
  derivationPath: Type.Optional(Type.String({ minLength: 1 }))
});

const CreatePasskeyWalletBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  walletName: Type.Optional(Type.String({ minLength: 1 })),
  addressFormat: Type.Optional(Type.String({ minLength: 1 })),
  derivationPath: Type.Optional(Type.String({ minLength: 1 })),
  passkey: Type.Object({
    challenge: Type.String({ minLength: 1 }), // base64url
    attestation: Type.Unknown()
  })
});

const CreateWalletResponse = Type.Object({
  resourceId: Type.String(),
  userId: Type.String(),
  externalUserId: Type.String(),
  organizationId: Type.String(),
  walletId: Type.String(),
  addresses: Type.Array(Type.String()),
  defaultAddress: Type.Union([Type.String(), Type.Null()]),
  activityId: Type.String()
});

const GetWalletResponse = Type.Object({
  id: Type.String(),
  userId: Type.Union([Type.String(), Type.Null()]),
  externalUserId: Type.Union([Type.String(), Type.Null()]),
  organizationId: Type.String(),
  walletId: Type.Union([Type.String(), Type.Null()]),
  defaultAddress: Type.Union([Type.String(), Type.Null()]),
  defaultAddressFormat: Type.Union([Type.String(), Type.Null()]),
  defaultDerivationPath: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String()
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
    "/turnkey/passkey-wallets",
    {
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
        const user = await getOrCreateUserByExternalId(client, { appId, externalUserId });
        return { ...res, userId: user.id };
      });

      if (consumed.kind === "replayed") return consumed.response;
      if (consumed.kind === "conflict") return reply.conflict(consumed.reason);
      if (consumed.kind === "in_progress") return reply.conflict(consumed.reason);
      if (consumed.kind === "failed") return reply.code(409).send({ message: consumed.reason, error: consumed.error });

      const userId = (consumed as { userId: string }).userId;
      const externalUserId = (body as any).externalUserId;
      const walletName = (body as any).walletName ?? `arch-embedded-${userId.slice(0, 8)}`;
      const addressFormat = (body as any).addressFormat ?? "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR";
      const derivationPath = (body as any).derivationPath ?? "m/86'/1'/0'/0/0";

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
            userEmail: undefined,
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

        const response = await withDbTransaction(db, async (client) => {
          const resource = await insertTurnkeyResource(client, {
            appId,
            userId,
            organizationId: created.subOrganizationId,
            walletId: created.walletId,
            vaultId: null,
            keyId: null,
            policyId: null,
            defaultAddress,
            defaultAddressFormat: addressFormat,
            defaultDerivationPath: derivationPath
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

  server.post(
    "/turnkey/wallets",
    {
      schema: {
        summary: "Create an embedded Turnkey-backed wallet (Phase 0)",
        tags: ["turnkey"],
        body: CreateWalletBody,
        response: { 200: CreateWalletResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const idempotencyKey = request.headers["idempotency-key"]?.toString();
      if (!idempotencyKey) {
        return reply.badRequest("Missing Idempotency-Key header");
      }

      const body = request.body as any;
      const route = "POST /v1/turnkey/wallets";
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
        const user = await getOrCreateUserByExternalId(client, { appId, externalUserId });
        return { ...res, userId: user.id };
      });

      if (consumed.kind === "replayed") return consumed.response;
      if (consumed.kind === "conflict") return reply.conflict(consumed.reason);
      if (consumed.kind === "in_progress") return reply.conflict(consumed.reason);
      if (consumed.kind === "failed")
        return reply.code(409).send({ message: consumed.reason, error: consumed.error });

      const userId = (consumed as { userId: string }).userId;
      const externalUserId = (body as any).externalUserId;
      const walletName = (body as any).walletName ?? `arch-embedded-${userId.slice(0, 8)}`;
      const addressFormat =
        (body as any).addressFormat ?? "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR";
      const derivationPath = (body as any).derivationPath ?? "m/86'/1'/0'/0/0";

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
          payloadJson: { walletName, addressFormat, derivationPath },
          outcome: "requested"
        });
      });

      try {
        const turnkey = getTurnkeyClient();
        const created = await turnkey.createBitcoinWallet({
          walletName,
          addressFormat,
          path: derivationPath
        });
        request.log.info(
          { activityId: created.activityId, walletId: created.walletId, userId },
          "turnkey.create_wallet.completed"
        );

        const defaultAddress = created.addresses[0] ?? null;

        const response = await withDbTransaction(db, async (client) => {
          const resource = await insertTurnkeyResource(client, {
            appId,
            userId,
            organizationId: server.config.TURNKEY_ORGANIZATION_ID,
            walletId: created.walletId,
            vaultId: null,
            keyId: null,
            policyId: null,
            defaultAddress,
            defaultAddressFormat: addressFormat,
            defaultDerivationPath: derivationPath
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
            organizationId: server.config.TURNKEY_ORGANIZATION_ID,
            walletId: created.walletId,
            addresses: created.addresses,
            defaultAddress,
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
          await markIdempotencyFailed(client, consumed.row.id, {
            message: String(err?.message ?? err)
          });
        });
        throw err;
      }
    }
  );

  server.get(
    "/turnkey/wallets",
    {
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

      return {
        externalUserId,
        userId: user.id,
        wallets: rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          externalUserId,
          organizationId: row.organization_id,
          walletId: row.wallet_id,
          defaultAddress: row.default_address,
          defaultAddressFormat: row.default_address_format,
          defaultDerivationPath: row.default_derivation_path,
          createdAt: row.created_at
        }))
      };
    }
  );

  server.get(
    "/turnkey/wallets/:resourceId",
    {
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

      return {
        id: row.id,
        userId: row.user_id,
        externalUserId,
        organizationId: row.organization_id,
        walletId: row.wallet_id,
        defaultAddress: row.default_address,
        defaultAddressFormat: row.default_address_format,
        defaultDerivationPath: row.default_derivation_path,
        createdAt: row.created_at
      };
    }
  );

  server.post(
    "/turnkey/sign-message",
    {
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
            payloadJson: { signature64Hex },
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
};
