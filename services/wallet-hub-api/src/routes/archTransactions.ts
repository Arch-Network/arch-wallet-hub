import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import {
  buildAndSignArchRuntimeTx,
  submitArchTransaction,
  createArchRpcClient,
  type BuildAndSignArchTxParams
} from "../arch/arch.js";
import { withDbTransaction } from "../db/tx.js";
import { getDbPool } from "../db/pool.js";
import { auditEvent } from "../audit/audit.js";
import { consumeIdempotencyKey, computeRequestHash } from "../idempotency/idempotency.js";
import { getTurnkeyResourceById, markIdempotencySucceeded, markIdempotencyFailed } from "../db/queries.js";
import { resolveArchAccountAddress } from "../arch/address.js";
import { SystemInstruction as SystemInstructionUtil, type Instruction, type Pubkey } from "@saturnbtcio/arch-sdk";
import bs58 from "bs58";

declare module "fastify" {
  interface FastifyInstance {
    db: import("pg").Pool;
    turnkey: import("../turnkey/client.js").TurnkeyService;
    config: import("../config/env.js").Env;
  }
}

// System transfer (ARCH native token)
const SystemTransferBody = Type.Object({
  userId: Type.String({ minLength: 1 }),
  resourceId: Type.String({ minLength: 1 }), // Turnkey resource ID
  toAddress: Type.String({ minLength: 1 }), // Arch account address or Taproot address
  lamports: Type.String({ minLength: 1 }) // Amount as string (to handle large numbers)
});

const SystemTransferResponse = Type.Object({
  txid: Type.String(),
  turnkeyActivityId: Type.String(),
  fromAddress: Type.String(),
  toAddress: Type.String(),
  lamports: Type.String()
});

// Generic instruction builder
const BuildInstructionBody = Type.Object({
  userId: Type.String({ minLength: 1 }),
  resourceId: Type.String({ minLength: 1 }),
  instructions: Type.Array(
    Type.Object({
      programId: Type.String({ minLength: 1 }), // Base58 or hex
      accounts: Type.Array(
        Type.Object({
          pubkey: Type.String({ minLength: 1 }),
          isSigner: Type.Boolean(),
          isWritable: Type.Boolean()
        })
      ),
      data: Type.String({ minLength: 1 }) // Hex string
    })
  )
});

const BuildInstructionResponse = Type.Object({
  txid: Type.String(),
  turnkeyActivityId: Type.String(),
  runtimeTransaction: Type.Object({
    version: Type.Number(),
    signatures: Type.Array(Type.String()),
    message: Type.Any()
  })
});

function parsePubkey(input: string): Pubkey {
  // Try base58 first, then hex
  try {
    return new Uint8Array(bs58.decode(input));
  } catch {
    // If base58 fails, try hex
    if (input.startsWith("0x")) {
      return new Uint8Array(Buffer.from(input.slice(2), "hex"));
    }
    return new Uint8Array(Buffer.from(input, "hex"));
  }
}

function parseLamports(input: string): bigint {
  const parsed = BigInt(input);
  if (parsed < 0n) {
    throw new Error("Lamports must be non-negative");
  }
  return parsed;
}

export const registerArchTransactionRoutes: FastifyPluginAsync = async (server) => {
  // System transfer endpoint (ARCH native token)
  server.post(
    "/arch/transfer",
    {
      schema: {
        summary: "Transfer ARCH native tokens (system transfer)",
        tags: ["arch-transactions"],
        body: SystemTransferBody,
        response: { 200: SystemTransferResponse }
      }
    },
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"]?.toString();
      if (!idempotencyKey) {
        return reply.badRequest("Missing Idempotency-Key header");
      }

      const body = request.body as any;
      const route = "POST /v1/arch/transfer";
      const requestHash = computeRequestHash(body);

      // Get db pool from global store (works in scoped plugins)
      const db = getDbPool();
      const config = request.server.config || server.config;
      const turnkey = request.server.turnkey || server.turnkey;

      const consumed = await withDbTransaction(db, async (client) => {
        return await consumeIdempotencyKey({
          client,
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

      const { userId, resourceId, toAddress, lamports: lamportsStr } = body;

      // Get Turnkey resource
      const resource = await withDbTransaction(db, (client) =>
        getTurnkeyResourceById(client, resourceId)
      );
      if (!resource) return reply.notFound("Unknown resourceId");
      if (resource.user_id !== userId) return reply.forbidden("Resource does not belong to user");
      if (!resource.default_address) {
        return reply.badRequest("Resource has no default address to sign with");
      }

      // Resolve addresses
      const fromResolved = resolveArchAccountAddress(resource.default_address);
      const toResolved = resolveArchAccountAddress(toAddress);
      const fromPubkey = parsePubkey(fromResolved.archAccountAddress);
      const toPubkey = parsePubkey(toResolved.archAccountAddress);
      const lamports = parseLamports(lamportsStr);

      // Check RPC node URL
      if (!server.config.ARCH_RPC_NODE_URL) {
        return reply.notImplemented("ARCH_RPC_NODE_URL not configured");
      }

      // Build system transfer instruction
      const transferInstruction = SystemInstructionUtil.transfer(
        fromPubkey,
        toPubkey,
        lamports
      );

      // Get recent blockhash
      const archRpc = createArchRpcClient(server.config.ARCH_RPC_NODE_URL);
      const recentBlockhashHex = await archRpc.getBestBlockHash();
      const recentBlockhash = new Uint8Array(Buffer.from(recentBlockhashHex, "hex"));

      // Audit: transaction requested
      await withDbTransaction(db, async (client) => {
        await auditEvent({
          client,
          requestId: request.id,
          userId,
          eventType: "arch.transfer.requested",
          entityType: "turnkey_resource",
          entityId: resourceId,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: {
            fromAddress: fromResolved.archAccountAddress,
            toAddress: toResolved.archAccountAddress,
            lamports: lamportsStr
          },
          outcome: "requested"
        });
      });

      try {
        // Build and sign transaction
        const { runtimeTransaction, turnkeyActivityId } = await buildAndSignArchRuntimeTx({
          turnkey,
          build: {
            instructions: [transferInstruction],
            payerPubkey: fromPubkey,
            recentBlockhash,
            signerBtcTaprootAddress: resource.default_address
          }
        });

        // Submit transaction
        const txid = await submitArchTransaction({
          nodeUrl: server.config.ARCH_RPC_NODE_URL,
          tx: runtimeTransaction
        });

        const responseBody = {
          txid,
          turnkeyActivityId,
          fromAddress: fromResolved.archAccountAddress,
          toAddress: toResolved.archAccountAddress,
          lamports: lamportsStr
        };

        await withDbTransaction(db, async (client) => {
          await auditEvent({
            client,
            requestId: request.id,
            userId,
            eventType: "arch.transfer.succeeded",
            entityType: "turnkey_resource",
            entityId: resourceId,
            turnkeyActivityId,
            turnkeyRequestId: null,
            payloadJson: responseBody,
            outcome: "succeeded"
          });
          await markIdempotencySucceeded(client, consumed.row.id, responseBody);
        });

        return responseBody;
      } catch (err: any) {
        await withDbTransaction(db, async (client) => {
          await auditEvent({
            client,
            requestId: request.id,
            userId,
            eventType: "arch.transfer.failed",
            entityType: "turnkey_resource",
            entityId: resourceId,
            turnkeyActivityId: null, // Not available in error path
            turnkeyRequestId: null,
            payloadJson: { error: String(err?.message ?? err), toAddress, lamports: lamportsStr },
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

  // Generic instruction builder endpoint
  server.post(
    "/arch/instructions/build",
    {
      schema: {
        summary: "Build and submit Arch transaction from custom instructions",
        tags: ["arch-transactions"],
        body: BuildInstructionBody,
        response: { 200: BuildInstructionResponse }
      }
    },
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"]?.toString();
      if (!idempotencyKey) {
        return reply.badRequest("Missing Idempotency-Key header");
      }

      const body = request.body as any;
      const route = "POST /v1/arch/instructions/build";
      const requestHash = computeRequestHash(body);

      // Get db pool from global store (works in scoped plugins)
      const db = getDbPool();
      const config = request.server.config || server.config;
      const turnkey = request.server.turnkey || server.turnkey;

      const consumed = await withDbTransaction(db, async (client) => {
        return await consumeIdempotencyKey({
          client,
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

      const { userId, resourceId, instructions: rawInstructions } = body;

      // Get Turnkey resource
      const resource = await withDbTransaction(db, (client) =>
        getTurnkeyResourceById(client, resourceId)
      );
      if (!resource) return reply.notFound("Unknown resourceId");
      if (resource.user_id !== userId) return reply.forbidden("Resource does not belong to user");
      if (!resource.default_address) {
        return reply.badRequest("Resource has no default address to sign with");
      }

      // Check RPC node URL
      if (!config.ARCH_RPC_NODE_URL) {
        return reply.notImplemented("ARCH_RPC_NODE_URL not configured");
      }

      // Parse instructions
      const instructions: Instruction[] = rawInstructions.map((raw: any) => ({
        program_id: parsePubkey(raw.programId),
        accounts: raw.accounts.map((acc: any) => ({
          pubkey: parsePubkey(acc.pubkey),
          is_signer: acc.isSigner,
          is_writable: acc.isWritable
        })),
        data: new Uint8Array(Buffer.from(raw.data, "hex"))
      }));

      // Resolve signer address
      const fromResolved = resolveArchAccountAddress(resource.default_address);
      const payerPubkey = parsePubkey(fromResolved.archAccountAddress);

      // Get recent blockhash
      const archRpc = createArchRpcClient(config.ARCH_RPC_NODE_URL);
      const recentBlockhashHex = await archRpc.getBestBlockHash();
      const recentBlockhash = new Uint8Array(Buffer.from(recentBlockhashHex, "hex"));

      // Audit: transaction requested
      await withDbTransaction(db, async (client) => {
        await auditEvent({
          client,
          requestId: request.id,
          userId,
          eventType: "arch.instructions.build.requested",
          entityType: "turnkey_resource",
          entityId: resourceId,
          turnkeyActivityId: null,
          turnkeyRequestId: null,
          payloadJson: {
            instructionCount: instructions.length,
            programIds: rawInstructions.map((raw: any) => raw.programId)
          },
          outcome: "requested"
        });
      });

      try {
        // Build and sign transaction
        const { runtimeTransaction, turnkeyActivityId } = await buildAndSignArchRuntimeTx({
          turnkey,
          build: {
            instructions,
            payerPubkey,
            recentBlockhash,
            signerBtcTaprootAddress: resource.default_address
          }
        });

        // Submit transaction
        const txid = await submitArchTransaction({
          nodeUrl: config.ARCH_RPC_NODE_URL,
          tx: runtimeTransaction
        });

        const responseBody = {
          txid,
          turnkeyActivityId,
          runtimeTransaction: {
            version: runtimeTransaction.version,
            signatures: runtimeTransaction.signatures.map((sig) => Buffer.from(sig).toString("hex")),
            message: runtimeTransaction.message
          }
        };

        await withDbTransaction(db, async (client) => {
          await auditEvent({
            client,
            requestId: request.id,
            userId,
            eventType: "arch.instructions.build.succeeded",
            entityType: "turnkey_resource",
            entityId: resourceId,
            turnkeyActivityId,
            turnkeyRequestId: null,
            payloadJson: { txid, instructionCount: instructions.length },
            outcome: "succeeded"
          });
          await markIdempotencySucceeded(client, consumed.row.id, responseBody);
        });

        return responseBody;
      } catch (err: any) {
        await withDbTransaction(db, async (client) => {
          await auditEvent({
            client,
            requestId: request.id,
            userId,
            eventType: "arch.instructions.build.failed",
            entityType: "turnkey_resource",
            entityId: resourceId,
            turnkeyActivityId: null, // Not available in error path
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
};
