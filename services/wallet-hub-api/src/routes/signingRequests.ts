import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { getDbPool } from "../db/pool.js";
import { withDbTransaction } from "../db/tx.js";
import { getOrCreateUserByExternalId } from "../db/apps.js";
import { insertSigningRequest, getSigningRequestForApp, markSigningRequestSubmitted, markSigningRequestSucceeded, markSigningRequestFailed } from "../db/signingRequests.js";
import { auditEvent } from "../audit/audit.js";
import { buildBip322ToSignPsbtBase64, extractBip322TaprootSignature64 } from "../bitcoin/bip322.js";
import { createArchRpcClient, submitArchTransaction, buildAndSignArchRuntimeTx, parsePubkey } from "../arch/arch.js";
import { getTurnkeyResourceByIdForApp } from "../db/queries.js";
import { getTurnkeyClient } from "../turnkey/store.js";
import { SystemInstruction as SystemInstructionUtil, SanitizedMessageUtil, SignatureUtil, type Instruction } from "@saturnbtcio/arch-sdk";
import { Buffer } from "node:buffer";
import bs58 from "bs58";
import { secp256k1 } from "@noble/curves/secp256k1";
import { getBtcPlatformClient } from "../btcPlatform/store.js";

const CreateSigningRequestBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  signer: Type.Union([
    Type.Object({
      kind: Type.Literal("external"),
      taprootAddress: Type.String({ minLength: 1 })
    }),
    Type.Object({
      kind: Type.Literal("turnkey"),
      resourceId: Type.String({ minLength: 1 })
    })
  ]),
  action: Type.Union([
    Type.Object({
      type: Type.Literal("arch.transfer"),
      toAddress: Type.String({ minLength: 1 }), // Arch or Taproot
      lamports: Type.String({ minLength: 1 })
    }),
    Type.Object({
      type: Type.Literal("arch.anchor"),
      btcTxid: Type.String({ minLength: 64, maxLength: 64 }),
      vout: Type.Integer({ minimum: 0 })
    })
  ])
});

const CreateSigningRequestResponse = Type.Object({
  signingRequestId: Type.String(),
  status: Type.String(),
  actionType: Type.String(),
  payloadToSign: Type.Unknown(),
  display: Type.Unknown(),
  expiresAt: Type.Union([Type.String(), Type.Null()]),
  result: Type.Optional(Type.Unknown())
});

const SubmitSignatureBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  signedTransaction: Type.String({ minLength: 1 }) // PSBT base64 or tx hex
});

const SubmitSignatureResponse = Type.Object({
  signingRequestId: Type.String(),
  status: Type.String(),
  result: Type.Unknown()
});

const SigningRequestReadiness = Type.Object({
  status: Type.Union([Type.Literal("ready"), Type.Literal("not_ready"), Type.Literal("unknown")]),
  reason: Type.Optional(Type.String()),
  anchoredUtxo: Type.Optional(
    Type.Object({
      txid: Type.String(),
      vout: Type.Integer()
    })
  ),
  btcAccountAddress: Type.Optional(Type.String()),
  confirmations: Type.Optional(Type.Integer({ minimum: 0 })),
  requiredConfirmations: Type.Optional(Type.Integer({ minimum: 0 }))
});

const GetSigningRequestParams = Type.Object({
  id: Type.String({ minLength: 1 })
});

const GetSigningRequestResponse = Type.Object({
  signingRequestId: Type.String(),
  status: Type.String(),
  actionType: Type.String(),
  display: Type.Unknown(),
  result: Type.Union([Type.Unknown(), Type.Null()]),
  error: Type.Union([Type.Unknown(), Type.Null()]),
  expiresAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  readiness: SigningRequestReadiness
});

function parseLamports(lamportsStr: string): bigint {
  const v = BigInt(lamportsStr);
  if (v < 0n) throw new Error("Lamports must be non-negative");
  return v;
}

function isTaprootAddress(s: string) {
  return s.startsWith("bc1p") || s.startsWith("tb1p") || s.startsWith("bcrt1p");
}

function isHex64(s: string) {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

function parseAnchoredUtxo(utxoStr: string): { txid: string; vout: number } | null {
  const m = utxoStr.match(/^([0-9a-fA-F]{64}):(\d+)$/);
  if (!m) return null;
  return { txid: m[1]!.toLowerCase(), vout: Number(m[2]) };
}

async function computeBtcUtxoReadiness(params: {
  archRpc: ReturnType<typeof createArchRpcClient> | null;
  payerPubkey: Uint8Array;
  requiredConfirmations: number;
  btc: ReturnType<typeof getBtcPlatformClient>;
}) {
  if (!params.archRpc) {
    return { status: "unknown", reason: "ArchRpcNotConfigured" } as const;
  }

  const accInfo: any = await params.archRpc.readAccountInfo(params.payerPubkey);
  const anchored = parseAnchoredUtxo(String(accInfo?.utxo ?? ""));
  if (!anchored) {
    return { status: "not_ready", reason: "NotAnchored" } as const;
  }

  if (!params.btc) {
    return {
      status: "unknown",
      reason: "BtcPlatformNotConfigured",
      anchoredUtxo: anchored,
      requiredConfirmations: params.requiredConfirmations
    } as const;
  }

  const btcAccountAddress = await params.archRpc.getAccountAddress(params.payerPubkey);
  const utxosRes: any = await params.btc.getAddressUtxos(btcAccountAddress, { confirmedOnly: false });
  const utxos: any[] = Array.isArray(utxosRes?.utxos) ? utxosRes.utxos : [];
  const matchUtxo = utxos.find(
    (u) => String(u?.txid ?? "").toLowerCase() === anchored.txid && Number(u?.vout) === anchored.vout
  );

  const confirmations = Number(matchUtxo?.confirmations ?? 0);
  if (confirmations < params.requiredConfirmations) {
    return {
      status: "not_ready",
      reason: "BtcUtxoNotConfirmed",
      anchoredUtxo: anchored,
      confirmations,
      requiredConfirmations: params.requiredConfirmations,
      btcAccountAddress
    } as const;
  }

  return {
    status: "ready",
    anchoredUtxo: anchored,
    confirmations,
    requiredConfirmations: params.requiredConfirmations,
    btcAccountAddress
  } as const;
}

function turnkeyPublicKeyToArchAccountBase58(publicKeyHex: string): string {
  // Turnkey wallet account publicKey is a secp256k1 public key (compressed or uncompressed).
  // Arch account keys are x-only pubkeys (32 bytes) derived from the *internal* key (untweaked).
  const pt = secp256k1.ProjectivePoint.fromHex(publicKeyHex).toAffine();
  const xHex = pt.x.toString(16).padStart(64, "0");
  return bs58.encode(Buffer.from(xHex, "hex"));
}

export const registerSigningRequestRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/signing-requests/:id",
    {
      schema: {
        summary: "Get a signing request (including live readiness status)",
        tags: ["signing-requests"],
        params: GetSigningRequestParams,
        response: { 200: GetSigningRequestResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const db = getDbPool();
      const { id } = request.params as any;
      const row = await withDbTransaction(db, (client) => getSigningRequestForApp(client, { id, appId }));
      if (!row) return reply.notFound("Unknown signingRequestId");

      // Compute live readiness (best-effort).
      let readiness: any = { status: "unknown", reason: "NotApplicable" };
      try {
        if (row.action_type === "arch.transfer") {
          const btc = getBtcPlatformClient();
          const archRpc = server.config.ARCH_RPC_NODE_URL ? createArchRpcClient(server.config.ARCH_RPC_NODE_URL) : null;
          const display: any = row.display_json ?? {};
          const fromArch = String(display?.from?.archAccountAddress ?? "");
          const payerPubkey = fromArch ? parsePubkey(fromArch) : null;
          if (payerPubkey) {
            readiness = await computeBtcUtxoReadiness({
              archRpc,
              payerPubkey,
              requiredConfirmations: server.config.BTC_MIN_CONFIRMATIONS ?? 20,
              btc
            });
          } else {
            readiness = { status: "unknown", reason: "MissingPayerAddress" };
          }
        }
      } catch {
        // ignore readiness errors
      }

      return {
        signingRequestId: row.id,
        status: row.status,
        actionType: row.action_type,
        display: row.display_json,
        result: row.result_json,
        error: row.error_json,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        readiness
      };
    }
  );

  // Create a signing request. For Turnkey signer, this endpoint will sign+submit immediately and return succeeded.
  server.post(
    "/signing-requests",
    {
      schema: {
        summary: "Create a signing request (payload-to-sign + display metadata)",
        tags: ["signing-requests"],
        body: CreateSigningRequestBody,
        response: { 200: CreateSigningRequestResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const db = getDbPool();
      const body = request.body as any;
      const user = await withDbTransaction(db, (client) =>
        getOrCreateUserByExternalId(client, { appId, externalUserId: body.externalUserId })
      );

      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      // Determine from signer identity.
      let signerTaprootAddress: string;
      let signerArchAccountAddress: string;
      let turnkeyResourceId: string | null = null;
      if (body.signer.kind === "external") {
        // External taproot address does not let us recover the internal x-only pubkey (the Arch account key).
        // For now, require an Arch account address for transaction submission.
        return reply.badRequest(
          "External signer cannot submit arch.transfer without providing an Arch account address (base58 pubkey)."
        );
      } else {
        turnkeyResourceId = body.signer.resourceId as string;
        const resource = await withDbTransaction(db, (client) =>
          getTurnkeyResourceByIdForApp(client, { id: turnkeyResourceId!, appId })
        );
        if (!resource) return reply.notFound("Unknown resourceId");
        if (resource.user_id !== user.id) return reply.forbidden("Resource does not belong to user");
        if (!resource.default_address) return reply.badRequest("Resource has no default address");
        signerTaprootAddress = resource.default_address;

        // Fetch wallet account details from Turnkey to get the internal public key (x-only) used as the Arch account key.
        const turnkey = getTurnkeyClient();
        const walletId = resource.wallet_id;
        if (!walletId) return reply.badRequest("Resource has no wallet_id");
        const accountsRes = await turnkey.getWalletAccounts({ walletId });
        const acct = accountsRes.accounts.find((a) => a.address === signerTaprootAddress);
        if (!acct?.publicKey) return reply.badRequest("Turnkey wallet account publicKey unavailable");
        signerArchAccountAddress = turnkeyPublicKeyToArchAccountBase58(acct.publicKey);
      }

      if (!signerArchAccountAddress) {
        // Should be set for turnkey signer above.
        return reply.internalServerError("Missing signer arch account address");
      }

      const payerPubkey = parsePubkey(signerArchAccountAddress);

      if (!server.config.ARCH_RPC_NODE_URL) return reply.notImplemented("ARCH_RPC_NODE_URL not configured");
      const archRpc = createArchRpcClient(server.config.ARCH_RPC_NODE_URL);
      const recentBlockhashHex = await archRpc.getBestBlockHash();
      const recentBlockhash = new Uint8Array(Buffer.from(recentBlockhashHex, "hex"));

      let actionType: "arch.transfer" | "arch.anchor";
      let instructions: Instruction[];
      let display: any;

      if (body.action.type === "arch.transfer") {
        if (isTaprootAddress(body.action.toAddress)) {
          return reply.badRequest(
            "toAddress must be an Arch account address (base58 pubkey). Taproot addresses cannot be inverted to Arch account keys."
          );
        }

        const toPubkey = parsePubkey(body.action.toAddress);
        const lamports = parseLamports(body.action.lamports);

        actionType = "arch.transfer";
        instructions = [SystemInstructionUtil.transfer(payerPubkey, toPubkey, lamports)];

        display = {
          kind: "arch.transfer",
          from: { taprootAddress: signerTaprootAddress, archAccountAddress: signerArchAccountAddress },
          to: { input: body.action.toAddress, archAccountAddress: body.action.toAddress },
          lamports: body.action.lamports,
          warnings:
            signerArchAccountAddress === body.action.toAddress
              ? ["Sender and recipient are the same"]
              : []
        };

        // Preflight: if payer is anchored to a BTC UTXO, require it to meet a minimum BTC
        // confirmation count before submitting the Arch tx. Otherwise the validator will
        // deterministically fail execution with "Transaction to sign empty".
        //
        // We only do this best-effort (won't block if BTC platform isn't configured).
        try {
          const readiness = await computeBtcUtxoReadiness({
            archRpc,
            payerPubkey,
            requiredConfirmations: server.config.BTC_MIN_CONFIRMATIONS ?? 20,
            btc: getBtcPlatformClient()
          });

          if (readiness.status === "not_ready") {
            return reply.code(409).send({
              statusCode: 409,
              error: readiness.reason ?? "NotReady",
              message:
                readiness.reason === "BtcUtxoNotConfirmed"
                  ? `Anchored BTC UTXO confirmations ${readiness.confirmations ?? 0} < required ${readiness.requiredConfirmations ?? server.config.BTC_MIN_CONFIRMATIONS ?? 20}`
                  : readiness.reason === "NotAnchored"
                    ? "Account is not anchored to a BTC UTXO. Fund the BTC account address and submit arch.anchor first."
                    : "Request is not ready",
              ...readiness
            });
          }
        } catch {
          // ignore preflight errors (best-effort)
        }
      } else if (body.action.type === "arch.anchor") {
        if (!isHex64(body.action.btcTxid)) {
          return reply.badRequest("btcTxid must be a 64-char hex string");
        }

        actionType = "arch.anchor";
        instructions = [SystemInstructionUtil.anchor(payerPubkey, body.action.btcTxid, body.action.vout)];

        // This is the BTC Taproot address that should receive a UTXO (via Titan/bitcoind),
        // which will then be referenced by (txid, vout) in the anchor instruction.
        const btcAccountAddress = await archRpc.getAccountAddress(payerPubkey);

        display = {
          kind: "arch.anchor",
          account: {
            taprootAddress: signerTaprootAddress,
            archAccountAddress: signerArchAccountAddress,
            btcAccountAddress
          },
          utxo: { txid: body.action.btcTxid, vout: body.action.vout }
        };
      } else {
        return reply.badRequest("Unsupported action type");
      }

      // Compute Arch message hash and BIP-322 payload to sign.
      const maybeMessage = SanitizedMessageUtil.createSanitizedMessage(instructions, payerPubkey, recentBlockhash);
      if (typeof maybeMessage === "string") throw new Error(`Arch message compilation failed: ${maybeMessage}`);
      const messageHash = SanitizedMessageUtil.hash(maybeMessage);
      const psbtBase64 = buildBip322ToSignPsbtBase64({
        signerAddress: signerTaprootAddress,
        message: Buffer.from(messageHash)
      });

      const payloadToSign = { kind: "bip322_psbt_base64", psbtBase64, recentBlockhashHex };

      // Persist request row now (pending). For Turnkey flow we'll immediately submit and mark succeeded.
      const row = await withDbTransaction(db, async (client) => {
        const created = await insertSigningRequest(client, {
          appId,
          userId: user.id,
          status: "pending",
          signerKind: body.signer.kind,
          signerAddress: body.signer.kind === "external" ? signerTaprootAddress : null,
          turnkeyResourceId,
          actionType,
          payloadToSign,
          display,
          expiresAt
        });

        await auditEvent({
          client,
          appId,
          requestId: request.id,
          userId: user.id,
          eventType: "signing_request.created",
          entityType: "signing_request",
          entityId: created.id,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: { actionType, signerKind: body.signer.kind },
          outcome: "succeeded"
        });

        return created;
      });

      // Turnkey signer: sign and submit immediately.
      if (body.signer.kind === "turnkey") {
        try {
          const turnkey = getTurnkeyClient();
          const { runtimeTransaction, turnkeyActivityId } = await buildAndSignArchRuntimeTx({
            turnkey,
            build: {
              instructions,
              payerPubkey,
              recentBlockhash,
              signerBtcTaprootAddress: signerTaprootAddress
            }
          });

          const txid = await submitArchTransaction({
            nodeUrl: server.config.ARCH_RPC_NODE_URL,
            tx: runtimeTransaction
          });

          const result = {
            txid,
            turnkeyActivityId,
            runtimeTransaction: {
              version: runtimeTransaction.version,
              signatures: runtimeTransaction.signatures.map((s) => Buffer.from(s).toString("hex")),
              message: runtimeTransaction.message
            }
          };

          await withDbTransaction(db, async (client) => {
            await markSigningRequestSucceeded(client, { id: row.id, resultJson: result });
            await auditEvent({
              client,
              appId,
              requestId: request.id,
              userId: user.id,
              eventType: "signing_request.succeeded",
              entityType: "signing_request",
              entityId: row.id,
              turnkeyActivityId,
              turnkeyRequestId: null,
              payloadJson: { txid },
              outcome: "succeeded"
            });
          });

          return {
            signingRequestId: row.id,
            status: "succeeded",
            actionType,
            payloadToSign,
            display,
            expiresAt,
            result
          };
        } catch (err: any) {
          await withDbTransaction(db, async (client) => {
            await markSigningRequestFailed(client, { id: row.id, errorJson: { message: String(err?.message ?? err) } });
          });
          throw err;
        }
      }

      // External signer: return payloadToSign + display for client UX.
      return {
        signingRequestId: row.id,
        status: row.status,
        actionType: row.action_type,
        payloadToSign,
        display,
        expiresAt
      };
    }
  );

  // Submit an external wallet signature (signed tx/psbt), then Hub submits to Arch.
  server.post(
    "/signing-requests/:id/submit",
    {
      schema: {
        summary: "Submit signature for a signing request (external signer)",
        tags: ["signing-requests"],
        params: Type.Object({ id: Type.String() }),
        body: SubmitSignatureBody,
        response: { 200: SubmitSignatureResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");
      // We currently require Turnkey-managed wallets for transaction submission, because
      // a Taproot address alone does not allow deriving the internal x-only pubkey that
      // Arch uses as the account identity.
      return reply.badRequest("External signer submission is not supported yet. Use a Turnkey signer.");
    }
  );
};
