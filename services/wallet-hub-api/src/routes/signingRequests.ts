import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { getDbPool } from "../db/pool.js";
import { withDbTransaction } from "../db/tx.js";
import { getOrCreateUserByExternalId } from "../db/apps.js";
import { insertSigningRequest, getSigningRequestForApp, markSigningRequestSubmitted, markSigningRequestSucceeded, markSigningRequestFailed } from "../db/signingRequests.js";
import { auditEvent } from "../audit/audit.js";
import { buildBip322ToSignPsbtBase64, computeBip322ToSignTaprootSighash, extractBip322TaprootSignature64 } from "../bitcoin/bip322.js";
import { createArchRpcClient, submitArchTransaction, buildAndSignArchRuntimeTx, parsePubkey } from "../arch/arch.js";
import { getTurnkeyResourceByIdForApp } from "../db/queries.js";
import { getTurnkeyClient } from "../turnkey/store.js";
import { SystemInstruction as SystemInstructionUtil, SanitizedMessageUtil, SignatureUtil, type Instruction } from "@saturnbtcio/arch-sdk";
import { Buffer } from "node:buffer";
import bs58 from "bs58";
import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { getBtcPlatformClient } from "../btcPlatform/store.js";
import { resolveArchAccountAddress } from "../arch/address.js";

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
  // One of:
  // - signature64Hex: 64-byte schnorr signature over BIP-322 toSign taproot sighash (r||s hex)
  // - signedTransaction: signed PSBT base64 or tx hex containing the taproot witness signature
  signature64Hex: Type.Optional(Type.String({ minLength: 128, maxLength: 128 })),
  signedTransaction: Type.Optional(Type.String({ minLength: 1 })),
  turnkeyActivityId: Type.Optional(Type.String({ minLength: 1 }))
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
  payloadToSign: Type.Unknown(),
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

function inferBtcNetworkFromAddress(address: string): "mainnet" | "testnet" | "regtest" | "unknown" {
  const a = String(address ?? "").toLowerCase();
  if (a.startsWith("bc1")) return "mainnet";
  if (a.startsWith("tb1")) return "testnet";
  if (a.startsWith("bcrt1")) return "regtest";
  return "unknown";
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
  requireAnchoredUtxo: boolean;
}) {
  if (!params.archRpc) {
    return { status: "unknown", reason: "ArchRpcNotConfigured" } as const;
  }

  let accInfo: any;
  try {
    accInfo = await params.archRpc.readAccountInfo(params.payerPubkey);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.toLowerCase().includes("account is not in database")) {
      return { status: "not_ready", reason: "ArchAccountNotFound" } as const;
    }
    return { status: "unknown", reason: `ArchRpcError: ${msg}` } as const;
  }

  // Some Arch deployments allow arch transfers without anchoring to a BTC UTXO.
  // In that configuration, skip *all* BTC readiness checks (including confirmations).
  if (!params.requireAnchoredUtxo) {
    return { status: "ready", reason: "AnchorNotRequired" } as const;
  }

  const anchored = parseAnchoredUtxo(String(accInfo?.utxo ?? ""));
  if (!anchored) {
    return params.requireAnchoredUtxo
      ? ({ status: "not_ready", reason: "NotAnchored" } as const)
      : ({ status: "ready", reason: "AnchorNotRequired" } as const);
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
  const inferred = inferBtcNetworkFromAddress(btcAccountAddress);
  if (inferred === "regtest") {
    return {
      status: "not_ready",
      reason: "ArchRpcNetworkMismatch",
      anchoredUtxo: anchored,
      btcAccountAddress,
      requiredConfirmations: params.requiredConfirmations,
      details:
        "Arch RPC is deriving a regtest (bcrt1...) BTC account address. Point Wallet Hub at a TESTNET-configured Arch node (ARCH_NETWORK_MODE=TESTNET) to use tb1... addresses."
    } as const;
  }
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
              btc,
              requireAnchoredUtxo: Boolean(server.config.ARCH_TRANSFER_REQUIRE_ANCHORED_UTXO)
            });
          } else {
            readiness = { status: "unknown", reason: "MissingPayerAddress" };
          }
        }
      } catch (err: any) {
        readiness = { status: "unknown", reason: `ReadinessError: ${String(err?.message ?? err)}` };
      }

      return {
        signingRequestId: row.id,
        status: row.status,
        actionType: row.action_type,
        payloadToSign: row.payload_to_sign,
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
        signerTaprootAddress = body.signer.taprootAddress as string;
        const resolved = resolveArchAccountAddress(signerTaprootAddress);
        if (resolved.kind !== "taproot") {
          return reply.badRequest("External signer must provide a Taproot (p2tr) address");
        }
        signerArchAccountAddress = resolved.archAccountAddress;
      } else {
        turnkeyResourceId = body.signer.resourceId as string;
        const resource = await withDbTransaction(db, (client) =>
          getTurnkeyResourceByIdForApp(client, { id: turnkeyResourceId!, appId })
        );
        if (!resource) return reply.notFound("Unknown resourceId");
        if (resource.user_id !== user.id) return reply.forbidden("Resource does not belong to user");
        if (!resource.default_address) return reply.badRequest("Resource has no default address");
        signerTaprootAddress = resource.default_address;
        const resolved = resolveArchAccountAddress(signerTaprootAddress);
        if (resolved.kind !== "taproot") {
          return reply.badRequest("Turnkey resource defaultAddress must be Taproot (p2tr)");
        }
        signerArchAccountAddress = resolved.archAccountAddress;
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
        // Non-custodial UX: we do NOT block request creation. Instead we attach a warning
        // and let clients poll GET /v1/signing-requests/:id for live readiness.
        try {
          const readiness = await computeBtcUtxoReadiness({
            archRpc,
            payerPubkey,
            requiredConfirmations: server.config.BTC_MIN_CONFIRMATIONS ?? 20,
            btc: getBtcPlatformClient(),
            requireAnchoredUtxo: Boolean(server.config.ARCH_TRANSFER_REQUIRE_ANCHORED_UTXO)
          });

          if (readiness.status === "not_ready") {
            const msg =
              readiness.reason === "BtcUtxoNotConfirmed"
                ? `Not ready: anchored BTC UTXO confirmations ${readiness.confirmations ?? 0} < required ${readiness.requiredConfirmations ?? server.config.BTC_MIN_CONFIRMATIONS ?? 20}`
                : readiness.reason === "NotAnchored"
                  ? "Not ready: account is not anchored to a BTC UTXO (submit arch.anchor first)"
                  : "Not ready";
            display.warnings = Array.isArray(display.warnings) ? display.warnings : [];
            display.warnings.push(msg);
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

      // For non-custodial Turnkey: clients sign the Taproot sighash directly via Turnkey SIGN_RAW_PAYLOAD
      // using a user-held credential (passkey/email/OAuth). We provide the digest to sign as hex.
      const sighash = computeBip322ToSignTaprootSighash({
        signerAddress: signerTaprootAddress,
        message: Buffer.from(messageHash)
      });
      const payloadToSign = {
        kind: "taproot_sighash_hex",
        signWith: signerTaprootAddress,
        payloadHex: Buffer.from(sighash).toString("hex"),
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NO_OP",
        // Optional debug/interop fields:
        psbtBase64,
        recentBlockhashHex
      };

      // Persist request row now (pending). Non-custodial: client must submit signature.
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

      // Always return payloadToSign + display for client UX. Client submits signature via /submit.
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

  // Submit a user-produced signature, then Hub submits to Arch.
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
      const db = getDbPool();
      const { id } = request.params as any;
      const body = request.body as any;

      const externalUserId: string = body.externalUserId;
      const user = await withDbTransaction(db, (client) =>
        getOrCreateUserByExternalId(client, { appId, externalUserId })
      );

      const row = await withDbTransaction(db, (client) => getSigningRequestForApp(client, { id, appId }));
      if (!row) return reply.notFound("Unknown signingRequestId");
      if (row.user_id !== user.id) return reply.forbidden("Signing request does not belong to user");
      if (row.status !== "pending") return reply.conflict(`Signing request status is ${row.status}`);
      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return reply.gone("Signing request expired");

      const display: any = row.display_json ?? {};
      const fromTaproot = String(display?.from?.taprootAddress ?? display?.account?.taprootAddress ?? "");
      if (!fromTaproot) return reply.badRequest("Signing request missing from.taprootAddress");

      const resolved = resolveArchAccountAddress(fromTaproot);
      if (resolved.kind !== "taproot") return reply.badRequest("from.taprootAddress must be Taproot (p2tr)");

      const payerPubkey = parsePubkey(resolved.archAccountAddress);
      const recentBlockhashHex = String((row.payload_to_sign as any)?.recentBlockhashHex ?? "");
      if (!recentBlockhashHex) return reply.badRequest("Signing request missing recentBlockhashHex");
      const recentBlockhash = new Uint8Array(Buffer.from(recentBlockhashHex, "hex"));

      // Enforce readiness on submit for arch.transfer.
      if (row.action_type === "arch.transfer") {
        if (!server.config.ARCH_RPC_NODE_URL) return reply.notImplemented("ARCH_RPC_NODE_URL not configured");
        const archRpc = createArchRpcClient(server.config.ARCH_RPC_NODE_URL);
        const readiness = await computeBtcUtxoReadiness({
          archRpc,
          payerPubkey,
          requiredConfirmations: server.config.BTC_MIN_CONFIRMATIONS ?? 20,
          btc: getBtcPlatformClient(),
          requireAnchoredUtxo: Boolean(server.config.ARCH_TRANSFER_REQUIRE_ANCHORED_UTXO)
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
                  : readiness.reason === "ArchAccountNotFound"
                    ? "Arch account not found. Fund the Arch account (airdrop) and then anchor a BTC UTXO."
                  : "Request is not ready",
            ...readiness
          });
        }
        if (readiness.status === "unknown") {
          return reply.code(409).send({
            statusCode: 409,
            error: readiness.reason ?? "Unknown",
            message: "Unable to determine readiness (Arch RPC / BTC platform). Try again shortly.",
            ...readiness
          });
        }
      }

      // Rebuild the instructions from stored display (authoritative intent).
      let instructions: Instruction[];
      if (row.action_type === "arch.transfer") {
        const toAddr = String(display?.to?.archAccountAddress ?? "");
        const lamportsStr = String(display?.lamports ?? "");
        if (!toAddr || !lamportsStr) return reply.badRequest("Signing request display missing transfer fields");
        const toPubkey = parsePubkey(toAddr);
        const lamports = parseLamports(lamportsStr);
        instructions = [SystemInstructionUtil.transfer(payerPubkey, toPubkey, lamports)];
      } else if (row.action_type === "arch.anchor") {
        const txid = String(display?.utxo?.txid ?? "");
        const vout = Number(display?.utxo?.vout);
        if (!txid || Number.isNaN(vout)) return reply.badRequest("Signing request display missing anchor fields");
        instructions = [SystemInstructionUtil.anchor(payerPubkey, txid, vout)];
      } else {
        return reply.badRequest("Unsupported action type");
      }

      // Determine signature input.
      let sig64: Buffer | null = null;
      let submittedSigJson: any = null;
      if (typeof body.signature64Hex === "string" && body.signature64Hex.length === 128) {
        sig64 = Buffer.from(body.signature64Hex, "hex");
        submittedSigJson = { kind: "signature64Hex", signature64Hex: body.signature64Hex, turnkeyActivityId: body.turnkeyActivityId ?? null };
      } else if (typeof body.signedTransaction === "string" && body.signedTransaction.length > 0) {
        sig64 = extractBip322TaprootSignature64({ signedTransaction: body.signedTransaction });
        submittedSigJson = { kind: "signedTransaction", signedTransaction: body.signedTransaction, turnkeyActivityId: body.turnkeyActivityId ?? null };
      } else {
        return reply.badRequest("Must provide signature64Hex or signedTransaction");
      }

      // Verify the signature against the expected Taproot output key and sighash (best-effort safety).
      const payloadHex = String((row.payload_to_sign as any)?.payloadHex ?? "");
      if (!payloadHex || payloadHex.length !== 64) {
        return reply.badRequest("Signing request missing taproot sighash payloadHex");
      }
      const ok = schnorr.verify(
        sig64,
        Buffer.from(payloadHex, "hex"),
        Buffer.from(resolved.xOnlyPubkeyHex, "hex")
      );
      if (!ok) return reply.unauthorized("Invalid signature for payload");

      // Build the runtime tx and submit.
      const maybeMessage = SanitizedMessageUtil.createSanitizedMessage(instructions, payerPubkey, recentBlockhash);
      if (typeof maybeMessage === "string") throw new Error(`Arch message compilation failed: ${maybeMessage}`);
      const adjusted = SignatureUtil.adjustSignature(Uint8Array.from(sig64));
      const runtimeTransaction = { version: 0, signatures: [adjusted], message: maybeMessage } as any;

      if (!server.config.ARCH_RPC_NODE_URL) return reply.notImplemented("ARCH_RPC_NODE_URL not configured");
      const txid = await submitArchTransaction({ nodeUrl: server.config.ARCH_RPC_NODE_URL, tx: runtimeTransaction });

      const result = {
        txid,
        turnkeyActivityId: body.turnkeyActivityId ?? null,
        runtimeTransaction: {
          version: runtimeTransaction.version,
          signatures: runtimeTransaction.signatures.map((s: Uint8Array) => Buffer.from(s).toString("hex")),
          message: runtimeTransaction.message
        }
      };

      await withDbTransaction(db, async (client) => {
        await markSigningRequestSubmitted(client, { id: row.id, submittedSignatureJson: submittedSigJson });
        await markSigningRequestSucceeded(client, { id: row.id, resultJson: result });
        await auditEvent({
          client,
          appId,
          requestId: request.id,
          userId: user.id,
          eventType: "signing_request.succeeded",
          entityType: "signing_request",
          entityId: row.id,
          turnkeyActivityId: body.turnkeyActivityId ?? null,
          turnkeyRequestId: null,
          payloadJson: { txid },
          outcome: "succeeded"
        });
      });

      return { signingRequestId: row.id, status: "succeeded", result };
    }
  );
};
