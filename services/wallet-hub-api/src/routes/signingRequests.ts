import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { getDbPool } from "../db/pool.js";
import { withDbTransaction } from "../db/tx.js";
import { getOrCreateUserByExternalId } from "../db/apps.js";
import { insertSigningRequest, getSigningRequestForApp, markSigningRequestSubmitted, markSigningRequestSucceeded, markSigningRequestFailed } from "../db/signingRequests.js";
import { auditEvent } from "../audit/audit.js";
import { buildBip322ToSignPsbtBase64, computeBip322ToSignTaprootSighash, extractBip322TaprootSignature64 } from "../bitcoin/bip322.js";
import { createArchRpcClient, submitArchTransaction, buildAndSignArchRuntimeTx, parsePubkey, getFinalizedBlockhash, waitForProcessedTransaction } from "../arch/arch.js";
import { getTurnkeyResourceByIdForApp, updateTurnkeyResourceDefaultPublicKeyHexForApp } from "../db/queries.js";
import { getTurnkeyClient } from "../turnkey/store.js";
import { SystemInstruction as SystemInstructionUtil, SanitizedMessageUtil, SignatureUtil, type Instruction } from "@saturnbtcio/arch-sdk";
import { Buffer } from "node:buffer";
import bs58 from "bs58";
import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { getBtcPlatformClient } from "../btcPlatform/store.js";
import { resolveArchAccountAddress } from "../arch/address.js";
import { address as btcAddress } from "bitcoinjs-lib";

const CreateSigningRequestBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  signer: Type.Union([
    Type.Object({
      kind: Type.Literal("external"),
      taprootAddress: Type.String({ minLength: 1 }),
      // Optional but strongly recommended: 33-byte compressed secp256k1 public key hex.
      // Arch identity uses the *internal* x-only key (untweaked), which cannot be recovered from a p2tr address.
      publicKeyHex: Type.Optional(Type.String({ minLength: 1 }))
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

  // Check if the account has a UTXO anchor. On Arch Network, the system program
  // requires UTXO data to generate the "transaction to sign". Without this, transfers
  // will fail with "Transaction to sign empty".
  const anchored = parseAnchoredUtxo(String(accInfo?.utxo ?? ""));
  
  // Sentinel value "0000...0000:0" or missing UTXO means account is not anchored.
  const isNullUtxo = !anchored || 
    (anchored.txid === "0000000000000000000000000000000000000000000000000000000000000000" && anchored.vout === 0);
  
  if (isNullUtxo) {
    // Even if requireAnchoredUtxo is false, the Arch system program still needs UTXO data.
    // Return not_ready so users know they need to anchor a UTXO first.
    return { 
      status: "not_ready", 
      reason: "NotAnchored",
      message: "Account has no UTXO anchor. You must first anchor a BTC UTXO to this account before transferring ARCH tokens.",
      anchoredUtxo: anchored ?? undefined
    } as const;
  }
  
  // If requireAnchoredUtxo is false, we have a UTXO but skip confirmation checks.
  // This allows faster transfers when the deployment doesn't require confirmed UTXOs.
  if (!params.requireAnchoredUtxo) {
    return { status: "ready", reason: "AnchorNotRequired", anchoredUtxo: anchored } as const;
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

function publicKeyHexToXOnlyHex(publicKeyHex: string): string {
  // Handle different public key formats:
  // - 32 bytes (64 hex chars): x-only key (Taproot/BIP-340), use directly
  // - 33 bytes (66 hex chars): compressed key, extract x coordinate
  // - 65 bytes (130 hex chars): uncompressed key, extract x coordinate
  const cleanHex = publicKeyHex.startsWith("0x") ? publicKeyHex.slice(2) : publicKeyHex;
  
  if (cleanHex.length === 64) {
    // Already x-only (32 bytes) - common for Taproot addresses from wallets like Xverse
    return cleanHex.toLowerCase();
  } else if (cleanHex.length === 66 || cleanHex.length === 130) {
    // Compressed (33 bytes) or uncompressed (65 bytes) - parse as point
    const pt = secp256k1.ProjectivePoint.fromHex(cleanHex).toAffine();
    return pt.x.toString(16).padStart(64, "0");
  } else {
    throw new Error(`Invalid public key length: ${cleanHex.length} hex chars (expected 64, 66, or 130)`);
  }
}

function turnkeyPublicKeyToArchAccountBase58(publicKeyHex: string): string {
  // Turnkey wallet account publicKey is a secp256k1 public key (compressed or uncompressed).
  // Arch account keys are x-only pubkeys (32 bytes) derived from the *internal* key (untweaked).
  const xHex = publicKeyHexToXOnlyHex(publicKeyHex);
  return bs58.encode(Buffer.from(xHex, "hex"));
}

function secp256k1PublicKeyToArchAccountBase58(publicKeyHex: string): string {
  // Alias for clarity; same conversion rules as Turnkey wallet account publicKey.
  return turnkeyPublicKeyToArchAccountBase58(publicKeyHex);
}

function secp256k1PublicKeyToXOnlyHex(publicKeyHex: string): string {
  return publicKeyHexToXOnlyHex(publicKeyHex);
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
      let row: any = await withDbTransaction(db, (client) => getSigningRequestForApp(client, { id, appId }));
      if (!row) return reply.notFound("Unknown signingRequestId");

      // If the request is still "submitted", best-effort reconcile it by asking the node for the processed tx.
      // This prevents UIs from getting stuck when the submit endpoint times out before the tx is indexed.
      try {
        if (row.status === "submitted" && server.config.ARCH_RPC_NODE_URL) {
          const txidHex = String((row.result_json as any)?.txidHex ?? "");
          const txidFallback = String((row.result_json as any)?.txid ?? "");
          const txidToQuery = txidHex || (txidFallback.length === 64 ? txidFallback : "");
          if (txidToQuery) {
            const processed = await waitForProcessedTransaction({
              nodeUrl: server.config.ARCH_RPC_NODE_URL,
              txid: txidToQuery,
              timeoutMs: 2_000,
              pollMs: 500
            });
            if (processed?.status?.type === "failed") {
              const errorJson = {
                txid: (row.result_json as any)?.txid ?? txidToQuery,
                txidHex: (row.result_json as any)?.txidHex ?? txidToQuery,
                txidBase58: (row.result_json as any)?.txidBase58 ?? null,
                status: processed.status,
                rollbackStatus: processed.rollback_status,
                logs: processed.logs
              };
              await withDbTransaction(db, (client) => markSigningRequestFailed(client, { id: row!.id, errorJson }));
              row = await withDbTransaction(db, (client) => getSigningRequestForApp(client, { id, appId }));
            } else if (processed?.status?.type === "processed") {
              await withDbTransaction(db, (client) =>
                markSigningRequestSucceeded(client, { id: row!.id, resultJson: { ...(row!.result_json as any), processedTransaction: processed } })
              );
              row = await withDbTransaction(db, (client) => getSigningRequestForApp(client, { id, appId }));
            }
          }
        }
      } catch {
        // ignore reconcile errors; GET should remain best-effort
      }

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
        } else if (row.action_type === "arch.anchor") {
          // For anchor, check if the Arch account exists (so we know the btcAccountAddress)
          const display: any = row.display_json ?? {};
          const fromArch = String(display?.account?.archAccountAddress ?? "");
          const btcAccountAddress = String(display?.account?.btcAccountAddress ?? "");
          const utxoTxid = String(display?.utxo?.txid ?? "");
          const utxoVout = Number(display?.utxo?.vout);
          
          if (!fromArch) {
            readiness = { status: "unknown", reason: "MissingArchAccount" };
          } else if (!btcAccountAddress || btcAccountAddress === "unknown") {
            readiness = { status: "not_ready", reason: "BtcAccountAddressUnknown", message: "Could not determine BTC account address. The Arch RPC may be unavailable." };
          } else if (!utxoTxid || Number.isNaN(utxoVout)) {
            readiness = { status: "not_ready", reason: "MissingUtxo", message: "UTXO txid and vout are required for anchor." };
          } else {
            // Anchor is ready to sign - we have the account and UTXO info
            // Note: We don't verify the UTXO exists/is confirmed here since that would require
            // querying the BTC indexer. The Arch node will validate it on submission.
            readiness = { 
              status: "ready", 
              btcAccountAddress,
              utxo: { txid: utxoTxid, vout: utxoVout }
            };
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
      let signerInternalXOnlyPubkeyHex: string | null = null;
      let turnkeyResourceId: string | null = null;
      if (body.signer.kind === "external") {
        signerTaprootAddress = body.signer.taprootAddress as string;
        const providedPubkeyHex = (body.signer.publicKeyHex ?? body.signer.public_key_hex) as string | undefined;
        if (providedPubkeyHex) {
          signerArchAccountAddress = secp256k1PublicKeyToArchAccountBase58(providedPubkeyHex);
          signerInternalXOnlyPubkeyHex = secp256k1PublicKeyToXOnlyHex(providedPubkeyHex);
        } else {
          // Backward compatibility: derive from address witness program (NOTE: this is the *tweaked* key for p2tr).
          // External wallets should supply a public key so we can use the *internal* key like Arch expects.
          const resolved = resolveArchAccountAddress(signerTaprootAddress);
          if (resolved.kind !== "taproot") {
            return reply.badRequest("External signer must provide a Taproot (p2tr) address");
          }
          signerArchAccountAddress = resolved.archAccountAddress;
          signerInternalXOnlyPubkeyHex = resolved.xOnlyPubkeyHex;
        }
      } else {
        turnkeyResourceId = body.signer.resourceId as string;
        const resource = await withDbTransaction(db, (client) =>
          getTurnkeyResourceByIdForApp(client, { id: turnkeyResourceId!, appId })
        );
        if (!resource) return reply.notFound("Unknown resourceId");
        if (resource.user_id !== user.id) return reply.forbidden("Resource does not belong to user");
        if (!resource.default_address) return reply.badRequest("Resource has no default address");
        signerTaprootAddress = resource.default_address;
        let pubkeyHex = (resource as any).default_public_key_hex as string | null;
        // Best-effort backfill for older rows: fetch wallet account public key from Turnkey.
        if (!pubkeyHex && resource.wallet_id && resource.organization_id) {
          try {
            const turnkey = getTurnkeyClient() as any;
            const accountsRes = await turnkey.getWalletAccountsForOrganization({
              organizationId: resource.organization_id,
              walletId: resource.wallet_id
            });
            const accounts = Array.isArray(accountsRes?.accounts) ? accountsRes.accounts : [];
            const match = accounts.find((a: any) => a?.address === signerTaprootAddress);
            const fetched = typeof match?.publicKey === "string" ? match.publicKey : null;
            if (fetched) {
              pubkeyHex = fetched;
              await withDbTransaction(db, (client) =>
                updateTurnkeyResourceDefaultPublicKeyHexForApp(client, {
                  id: turnkeyResourceId!,
                  appId,
                  defaultPublicKeyHex: fetched
                })
              );
            }
          } catch (e: any) {
            server.log.warn(
              { err: String(e?.message ?? e), resourceId: turnkeyResourceId, walletId: resource.wallet_id },
              "Failed to backfill Turnkey wallet public key"
            );
          }
        }
        if (pubkeyHex) {
          signerArchAccountAddress = turnkeyPublicKeyToArchAccountBase58(pubkeyHex);
          signerInternalXOnlyPubkeyHex = secp256k1PublicKeyToXOnlyHex(pubkeyHex);
        } else {
          // Backward compatibility for older rows. This path is likely WRONG for Taproot because it uses the tweaked key.
          const resolved = resolveArchAccountAddress(signerTaprootAddress);
          if (resolved.kind !== "taproot") {
            return reply.badRequest("Turnkey resource defaultAddress must be Taproot (p2tr)");
          }
          signerArchAccountAddress = resolved.archAccountAddress;
          signerInternalXOnlyPubkeyHex = resolved.xOnlyPubkeyHex;
          server.log.warn(
            { resourceId: turnkeyResourceId, defaultAddress: signerTaprootAddress },
            "Turnkey resource missing default_public_key_hex; derived Arch account from address (may cause invalid signatures)"
          );
        }
      }

      if (!signerArchAccountAddress) {
        // Should be set for turnkey signer above.
        return reply.internalServerError("Missing signer arch account address");
      }

      const payerPubkey = parsePubkey(signerArchAccountAddress);

      if (!server.config.ARCH_RPC_NODE_URL) return reply.notImplemented("ARCH_RPC_NODE_URL not configured");
      // Prefer finalized blockhash (required for transaction validation), fallback to best.
      // Add timeout to prevent hanging on slow/unresponsive Arch RPC.
      let recentBlockhashHex: string;
      try {
        const blockhashPromise = getFinalizedBlockhash(server.config.ARCH_RPC_NODE_URL);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Blockhash fetch timeout")), 5000); // 5 second timeout
        });
        recentBlockhashHex = await Promise.race([blockhashPromise, timeoutPromise]);
      } catch (err: any) {
        server.log.error({ err: String(err?.message ?? err) }, "Failed to get blockhash from Arch RPC");
        return reply.code(503).send({
          statusCode: 503,
          error: "Service Unavailable",
          message: `Arch RPC unavailable: ${String(err?.message ?? err)}`
        });
      }
      if (!recentBlockhashHex || recentBlockhashHex.length !== 64) {
        return reply.code(503).send({
          statusCode: 503,
          error: "Service Unavailable",
          message: `Invalid blockhash from Arch RPC: ${recentBlockhashHex}`
        });
      }
      const recentBlockhash = new Uint8Array(Buffer.from(recentBlockhashHex, "hex"));
      const archRpc = createArchRpcClient(server.config.ARCH_RPC_NODE_URL);

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
          from: {
            taprootAddress: signerTaprootAddress,
            archAccountAddress: signerArchAccountAddress,
            xOnlyPubkeyHex: signerInternalXOnlyPubkeyHex
          },
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
        // Add a timeout to prevent hanging on slow/unresponsive Arch RPC.
        try {
          const readinessPromise = computeBtcUtxoReadiness({
            archRpc,
            payerPubkey,
            requiredConfirmations: server.config.BTC_MIN_CONFIRMATIONS ?? 20,
            btc: getBtcPlatformClient(),
            requireAnchoredUtxo: Boolean(server.config.ARCH_TRANSFER_REQUIRE_ANCHORED_UTXO)
          });
          
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("Readiness check timeout")), 5000); // 5 second timeout
          });
          
          const readiness = await Promise.race([readinessPromise, timeoutPromise]);

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
        } catch (err: any) {
          // ignore preflight errors (best-effort) - including timeouts
          server.log.debug({ err: String(err?.message ?? err) }, "Preflight readiness check failed or timed out");
        }
      } else if (body.action.type === "arch.anchor") {
        if (!isHex64(body.action.btcTxid)) {
          return reply.badRequest("btcTxid must be a 64-char hex string");
        }

        actionType = "arch.anchor";
        instructions = [SystemInstructionUtil.anchor(payerPubkey, body.action.btcTxid, body.action.vout)];

        // This is the BTC Taproot address that should receive a UTXO (via Titan/bitcoind),
        // which will then be referenced by (txid, vout) in the anchor instruction.
        // Add timeout to prevent hanging on slow/unresponsive Arch RPC.
        let btcAccountAddress: string;
        try {
          const addressPromise = archRpc.getAccountAddress(payerPubkey);
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("getAccountAddress timeout")), 5000); // 5 second timeout
          });
          btcAccountAddress = await Promise.race([addressPromise, timeoutPromise]);
        } catch (err: any) {
          server.log.warn({ err: String(err?.message ?? err) }, "Failed to get BTC account address, using placeholder");
          btcAccountAddress = "unknown"; // Fallback - client can retry later
        }

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
      
      // For tapInternalKey, use the INTERNAL key (from wallet's public key) if available,
      // otherwise fall back to the OUTPUT key from the address (which may cause signature mismatches
      // with BIP-86 wallets like Xverse that use key tweaking).
      let xOnlyPubkey: Buffer;
      if (signerInternalXOnlyPubkeyHex) {
        // Use the internal key from the wallet's public key (correct for BIP-86 wallets)
        xOnlyPubkey = Buffer.from(signerInternalXOnlyPubkeyHex, "hex");
        server.log.info({ signerInternalXOnlyPubkeyHex }, "Using internal key from wallet public key for PSBT tapInternalKey");
      } else {
        // Fallback: extract from address (this is the tweaked/output key, may not work with Xverse)
        const decodedAddress = btcAddress.fromBech32(signerTaprootAddress);
        if (decodedAddress.version !== 1 || decodedAddress.data.length !== 32) {
          throw new Error("Invalid Taproot address for BIP-322 signing (must be bech32m v1 with 32-byte witness program)");
        }
        xOnlyPubkey = Buffer.from(decodedAddress.data);
        server.log.warn({ signerTaprootAddress }, "Using address-derived key for PSBT tapInternalKey (may cause signature issues with BIP-86 wallets)");
      }
      
      const psbtBase64 = buildBip322ToSignPsbtBase64({
        signerAddress: signerTaprootAddress,
        message: Buffer.from(messageHash),
        tapInternalKey: xOnlyPubkey  // Required for Xverse/external wallets to sign
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
        // For external wallets (Xverse/Unisat): pass the message hash to signMessage().
        // The wallet computes the BIP-322 signature internally.
        messageHashHex: Buffer.from(messageHash).toString("hex"),
        // Optional debug/interop fields:
        psbtBase64,
        recentBlockhashHex,
        // Store internal key for debugging signature verification (BIP-86 tweak issues)
        internalXOnlyPubkeyHex: signerInternalXOnlyPubkeyHex,
        // Also store the PSBT's tapInternalKey for comparison
        psbtTapInternalKeyHex: xOnlyPubkey.toString("hex")
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
      // Support both transfer (from.*) and anchor (account.*) display structures
      const fromTaproot = String(display?.from?.taprootAddress ?? display?.account?.taprootAddress ?? "");
      if (!fromTaproot) return reply.badRequest("Signing request missing from.taprootAddress");

      const fromArch = String(display?.from?.archAccountAddress ?? display?.account?.archAccountAddress ?? "");
      if (!fromArch) return reply.badRequest("Signing request missing from.archAccountAddress");
      const payerPubkey = parsePubkey(fromArch);
      const internalXOnlyPubkeyHex = String(display?.from?.xOnlyPubkeyHex ?? display?.account?.xOnlyPubkeyHex ?? "");
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

      // Get the exact signer address and payload from the stored signing request.
      const payloadToSign: any = row.payload_to_sign ?? {};
      const payloadHex = String(payloadToSign?.payloadHex ?? "");
      const storedSignWith = String(payloadToSign?.signWith ?? "");
      if (!payloadHex || payloadHex.length !== 64) {
        return reply.badRequest("Signing request missing taproot sighash payloadHex");
      }
      if (!storedSignWith) {
        return reply.badRequest("Signing request missing signWith address");
      }
      
      // Verify the signature against the stored Taproot output key + payload.
      //
      // IMPORTANT:
      // - BIP-322 for P2TR verifies against the Taproot *output* key (the v1 witness program), not the internal key.
      // - If this check fails, the node may still return a txid for send_transaction but will drop the tx during
      //   later validation, which presents as get_processed_transaction = NOT FOUND.
      let taprootOutputXOnlyHex: string | null = null;
      try {
        const resolved = resolveArchAccountAddress(storedSignWith);
        if (resolved.kind !== "taproot") {
          return reply.badRequest("Signing request signWith must be a Taproot (p2tr) address");
        }
        taprootOutputXOnlyHex = resolved.xOnlyPubkeyHex;
      } catch (err: any) {
        server.log.warn({ storedSignWith, err: err?.message ?? String(err) }, "Failed to parse Taproot address for signature verification");
        return reply.badRequest("Signing request signWith must be a valid Taproot (p2tr) address");
      }

      const payloadBuf = Buffer.from(payloadHex, "hex");
      const outputKeyBuf = Buffer.from(taprootOutputXOnlyHex, "hex");
      const okOutputKey = schnorr.verify(sig64, payloadBuf, outputKeyBuf);
      
      // Also try verifying against internal key if available (for debugging BIP-86 tweak issues)
      let okInternalKey = false;
      const storedInternalKeyHex = String((payloadToSign as any)?.internalXOnlyPubkeyHex ?? "");
      if (storedInternalKeyHex && storedInternalKeyHex.length === 64) {
        okInternalKey = schnorr.verify(sig64, payloadBuf, Buffer.from(storedInternalKeyHex, "hex"));
      }
      
      server.log.info({
        signatureHex: Buffer.from(sig64).toString("hex"),
        payloadHex,
        outputKeyHex: taprootOutputXOnlyHex,
        internalKeyHex: storedInternalKeyHex || "(not stored)",
        okOutputKey,
        okInternalKey,
      }, "Signature verification results");
      
      if (!okOutputKey) {
        // If signature verifies against internal key but not output key, it's a BIP-86 tweak issue
        const errorDetail = okInternalKey 
          ? "Signature verifies against internal key but NOT the tweaked output key. The wallet may not be applying the BIP-86 tweak when signing."
          : "Signature does not verify against either output key or internal key. Check that the wallet is signing the correct sighash.";
        
        server.log.warn(
          {
            storedSignWith,
            payloadHex,
            signature64Hex: body.signature64Hex ?? null,
            taprootOutputXOnlyHex,
            storedInternalKeyHex,
            okInternalKey,
            errorDetail
          },
          "Local schnorr.verify failed - rejecting"
        );
        return reply.code(400).send({
          statusCode: 400,
          error: "InvalidSignature",
          message: `Signature did not verify for Taproot output key (p2tr). ${errorDetail}`
        });
      }

      // Additional debug-only sanity check: verify against the *internal* x-only key when we have it.
      if (internalXOnlyPubkeyHex && internalXOnlyPubkeyHex.length === 64) {
        const ok = schnorr.verify(
          sig64,
          payloadBuf,
          Buffer.from(internalXOnlyPubkeyHex, "hex")
        );
        if (!ok) {
          server.log.warn(
            {
              payloadHex,
              signature64Hex: body.signature64Hex,
              internalXOnlyPubkeyHex,
              storedSignWith,
              taprootOutputXOnlyHex
            },
            "Local schnorr.verify failed (internal key) - signature might still be valid for tweaked key"
          );
        }
      }

      // Build the runtime tx and submit.
      const maybeMessage = SanitizedMessageUtil.createSanitizedMessage(instructions, payerPubkey, recentBlockhash);
      if (typeof maybeMessage === "string") throw new Error(`Arch message compilation failed: ${maybeMessage}`);
      
      // Verify the message hash matches what we signed (defensive check).
      const messageHash = SanitizedMessageUtil.hash(maybeMessage);
      const expectedSighash = computeBip322ToSignTaprootSighash({
        signerAddress: storedSignWith, // Use the exact address from the stored payload
        message: Buffer.from(messageHash)
      });
      const expectedPayloadHex = Buffer.from(expectedSighash).toString("hex");
      if (expectedPayloadHex !== payloadHex) {
        server.log.error(
          {
            expectedPayloadHex,
            storedPayloadHex: payloadHex,
            messageHashHex: Buffer.from(messageHash).toString("hex"),
            recentBlockhashHex,
            storedSignWith,
            fromTaproot
          },
          "Message hash mismatch - signature will fail"
        );
        return reply.code(400).send({
          statusCode: 400,
          error: "MessageHashMismatch",
          message: "The transaction message hash does not match what was signed. The signing request may be stale or corrupted.",
          expectedPayloadHex,
          storedPayloadHex: payloadHex
        });
      }
      
      // Some client libs normalize the schnorr signature bytes; keep it explicit for Arch.
      const adjusted = SignatureUtil.adjustSignature(Uint8Array.from(sig64));
      const runtimeTransaction = { version: 0, signatures: [adjusted], message: maybeMessage } as any;

      // Debug: Log the pubkey that Arch will use for verification
      const archPayerPubkey = maybeMessage.account_keys[0];
      const archPayerPubkeyHex = Buffer.from(archPayerPubkey).toString("hex");
      
      // Recompute the sighash for debugging (this should match payloadHex)
      const recomputedSighash = computeBip322ToSignTaprootSighash({
        signerAddress: storedSignWith,
        message: Buffer.from(messageHash)
      });
      const recomputedPayloadHex = Buffer.from(recomputedSighash).toString("hex");
      
      server.log.error(
        {
          archPayerPubkeyHex,
          internalXOnlyPubkeyHex,
          signature64Hex: body.signature64Hex,
          adjustedSigHex: Buffer.from(adjusted).toString("hex"),
          messageHashHex: Buffer.from(messageHash).toString("hex"),
          payloadHex,
          recomputedPayloadHex,
          payloadMatches: payloadHex === recomputedPayloadHex,
          recentBlockhashHex,
          storedSignWith,
          fromTaproot,
          // Additional debug info
          messageAccountKeysCount: maybeMessage.account_keys.length,
          messageInstructionsCount: maybeMessage.instructions.length,
          messageHeader: {
            numRequiredSignatures: maybeMessage.header.num_required_signatures,
            numReadonlySignedAccounts: maybeMessage.header.num_readonly_signed_accounts,
            numReadonlyUnsignedAccounts: maybeMessage.header.num_readonly_unsigned_accounts
          }
        },
        "Submitting Arch transaction with signature - DEBUG"
      );

      if (!server.config.ARCH_RPC_NODE_URL) return reply.notImplemented("ARCH_RPC_NODE_URL not configured");
      server.log.info(
        {
          signingRequestId: row.id,
          actionType: row.action_type,
          nodeUrl: server.config.ARCH_RPC_NODE_URL,
          signWith: storedSignWith
        },
        "arch.send_transaction.requested"
      );
      const txidHex = await submitArchTransaction({ nodeUrl: server.config.ARCH_RPC_NODE_URL, tx: runtimeTransaction });
      // Arch RPC txids are 32-byte values; the RPC returns them as a 64-hex string.
      // For client UX (wallet/explorer-like), we return base58 while preserving the hex for RPC lookups.
      const txidBase58 = (() => {
        try {
          const buf = Buffer.from(txidHex, "hex");
          return buf.length === 32 ? bs58.encode(buf) : null;
        } catch {
          return null;
        }
      })();
      server.log.info(
        { signingRequestId: row.id, txidHex, txidBase58, nodeUrl: server.config.ARCH_RPC_NODE_URL },
        "arch.send_transaction.accepted"
      );

      const submitResult = {
        txid: txidBase58 ?? txidHex,
        txidHex,
        txidBase58,
        turnkeyActivityId: body.turnkeyActivityId ?? null,
        runtimeTransaction: {
          version: runtimeTransaction.version,
          signatures: runtimeTransaction.signatures.map((s: Uint8Array) => Buffer.from(s).toString("hex")),
          message: runtimeTransaction.message
        }
      };

      // Persist as submitted immediately (tx broadcast).
      await withDbTransaction(db, async (client) => {
        await markSigningRequestSubmitted(client, {
          id: row.id,
          submittedSignatureJson: submittedSigJson,
          resultJson: { txid: txidBase58 ?? txidHex, txidHex, txidBase58 }
        });
      });

      // Best-effort: wait briefly for execution result so we can return a truthful status to clients/UX.
      const processed = await waitForProcessedTransaction({
        nodeUrl: server.config.ARCH_RPC_NODE_URL,
        txid: txidHex,
        timeoutMs: 10_000,
        pollMs: 500
      });
      server.log.info(
        {
          signingRequestId: row.id,
          txidHex,
          txidBase58,
          processedStatus: processed?.status?.type ?? "not_found",
          processedMessage: (processed as any)?.status?.message ?? null
        },
        "arch.get_processed_transaction.result"
      );

      if (processed?.status?.type === "failed") {
        const errorJson = {
          txid: txidBase58 ?? txidHex,
          txidHex,
          txidBase58,
          status: processed.status,
          rollbackStatus: processed.rollback_status,
          logs: processed.logs
        };
        await withDbTransaction(db, async (client) => {
          await markSigningRequestFailed(client, { id: row.id, errorJson });
          await auditEvent({
            client,
            appId,
            requestId: request.id,
            userId: user.id,
            eventType: "signing_request.failed",
            entityType: "signing_request",
            entityId: row.id,
            turnkeyActivityId: body.turnkeyActivityId ?? null,
            turnkeyRequestId: null,
            payloadJson: errorJson,
            outcome: "failed"
          });
        });
        return { signingRequestId: row.id, status: "failed", result: errorJson };
      }

      if (processed?.status?.type === "processed") {
        const result = {
          ...submitResult,
          processedTransaction: processed
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
            turnkeyActivityId: body.turnkeyActivityId ?? null,
            turnkeyRequestId: null,
            payloadJson: { txid: submitResult.txid, txidHex: submitResult.txidHex, txidBase58: submitResult.txidBase58 },
            outcome: "succeeded"
          });
        });
        return { signingRequestId: row.id, status: "succeeded", result };
      }

      // Still processing / not found yet: return submitted so clients can poll.
      return { signingRequestId: row.id, status: "submitted", result: submitResult };
    }
  );

  // Sign and submit a signing request using Turnkey (server-side signing)
  // This endpoint signs with Turnkey and then internally forwards to the submit endpoint
  server.post(
    "/signing-requests/:id/sign-with-turnkey",
    {
      schema: {
        summary: "Sign a signing request using Turnkey (server-side)",
        tags: ["signing-requests"],
        params: Type.Object({ id: Type.String() }),
        body: Type.Object({
          externalUserId: Type.String({ minLength: 1 })
        }),
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

      // Get the Turnkey resource ID from the signing request
      const turnkeyResourceId = (row as any).turnkey_resource_id;
      if (!turnkeyResourceId) {
        return reply.badRequest("Signing request was not created with a Turnkey signer");
      }

      const resource = await withDbTransaction(db, (client) =>
        getTurnkeyResourceByIdForApp(client, { id: turnkeyResourceId, appId })
      );
      if (!resource) return reply.notFound("Turnkey resource not found");
      if (resource.user_id !== user.id) return reply.forbidden("Turnkey resource does not belong to user");
      if (!resource.default_address) return reply.badRequest("Turnkey resource has no default address");

      // Check if this is a passkey wallet (sub-organization) - server can't sign for these
      const rootOrgId = server.config.TURNKEY_ORGANIZATION_ID;
      if (resource.organization_id !== rootOrgId) {
        return reply.code(400).send({
          statusCode: 400,
          error: "PasskeyWalletNotSupported",
          message: "This wallet is a passkey wallet in a sub-organization. Server-side signing is not supported - the user's passkey must sign on the client side. Use an external wallet or a regular Turnkey wallet for server-side signing."
        });
      }

      const payloadToSign: any = row.payload_to_sign ?? {};
      const payloadHex = String(payloadToSign?.payloadHex ?? "");
      if (!payloadHex || payloadHex.length !== 64) {
        return reply.badRequest("Signing request missing taproot sighash payloadHex");
      }

      // Sign using Turnkey
      let signature64Hex: string;
      let turnkeyActivityId: string | null = null;
      try {
        const turnkey = getTurnkeyClient();
        const signed = await turnkey.signRawPayload({
          signWith: resource.default_address,
          payload: payloadHex,
          encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
          hashFunction: "HASH_FUNCTION_NO_OP",
          organizationId: resource.organization_id // Use sub-org ID for passkey wallets
        });
        signature64Hex = `${signed.r}${signed.s}`;
        turnkeyActivityId = signed.activityId ?? null;
        request.log.info(
          { activityId: signed.activityId, resourceId: turnkeyResourceId, signingRequestId: row.id, organizationId: resource.organization_id },
          "turnkey.sign_signing_request.completed"
        );
      } catch (e: any) {
        request.log.error(
          { err: e, resourceId: turnkeyResourceId, signingRequestId: row.id, organizationId: resource.organization_id, defaultAddress: resource.default_address },
          "turnkey.sign_signing_request.failed"
        );
        return reply.internalServerError(`Turnkey signing failed: ${e?.message ?? "Unknown error"}`);
      }

      // Now forward to the submit endpoint by injecting the request
      const submitResponse = await server.inject({
        method: "POST",
        url: `/v1/signing-requests/${id}/submit`,
        headers: {
          "x-api-key": request.headers["x-api-key"] as string,
          "content-type": "application/json"
        },
        payload: {
          externalUserId,
          signature64Hex,
          turnkeyActivityId
        }
      });

      // Forward the response
      reply.code(submitResponse.statusCode);
      return submitResponse.json();
    }
  );
};
