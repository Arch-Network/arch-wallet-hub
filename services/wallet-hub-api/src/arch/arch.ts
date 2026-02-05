import {
  ArchConnection,
  RpcConnection,
  SanitizedMessageUtil,
  SignatureUtil,
  type Instruction,
  type RuntimeTransaction
} from "@saturnbtcio/arch-sdk";
import { computeBip322ToSignTaprootSighash } from "../bitcoin/bip322.js";
import type { TurnkeyService } from "../turnkey/client.js";
import bs58 from "bs58";

export type BuildAndSignArchTxParams = {
  instructions: Instruction[];
  payerPubkey: Uint8Array; // 32 bytes (taproot-mapped identity)
  recentBlockhash: Uint8Array;
  signerBtcTaprootAddress: string;
};

/**
 * Build an Arch runtime transaction and sign it using BIP-322 (Taproot identity) via Turnkey.
 *
 * Architectural boundary:
 * - Wallet Hub constructs the message (Arch semantics) and the BIP-322 signing artifact (Bitcoin semantics).
 * - Turnkey only performs the signing operation with the custody-held key.
 */
export async function buildAndSignArchRuntimeTx(params: {
  turnkey: TurnkeyForArch;
  build: BuildAndSignArchTxParams;
}): Promise<{ runtimeTransaction: RuntimeTransaction; turnkeyActivityId: string }> {
  const maybeMessage = SanitizedMessageUtil.createSanitizedMessage(
    params.build.instructions,
    params.build.payerPubkey,
    params.build.recentBlockhash
  );
  if (typeof maybeMessage === "string") {
    // CompileError is a string enum in the SDK.
    throw new Error(`Arch message compilation failed: ${maybeMessage}`);
  }
  const message = maybeMessage;

  const messageHash = SanitizedMessageUtil.hash(message); // Uint8Array

  // BIP-322 signs "message bytes". Arch verifies BIP-322 over message.hash() bytes.
  // We compute the Taproot sighash for the BIP-322 toSign transaction and ask Turnkey
  // to sign that digest directly via SIGN_RAW_PAYLOAD. This avoids Turnkey's PSBT parser
  // limitations for BIP-322 PSBTs (the toSign tx uses OP_RETURN output).
  const sighash = computeBip322ToSignTaprootSighash({
    signerAddress: params.build.signerBtcTaprootAddress,
    message: Buffer.from(messageHash)
  });

  const signed = await params.turnkey.signRawPayload({
    signWith: params.build.signerBtcTaprootAddress,
    payload: Buffer.from(sighash).toString("hex"),
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
    hashFunction: "HASH_FUNCTION_NO_OP"
  });

  const sig64 = Buffer.from(`${signed.r}${signed.s}`, "hex");

  // Some client libs normalize the schnorr signature bytes; keep it explicit for Arch.
  const adjusted = SignatureUtil.adjustSignature(Uint8Array.from(sig64));

  return {
    runtimeTransaction: {
      // Arch RPC expects version 0 (see arch-network RPC docs).
      version: 0,
      signatures: [adjusted],
      message
    },
    turnkeyActivityId: signed.activityId
  };
}

export type TurnkeyForArch = Pick<TurnkeyService, "signRawPayload">;

export function createArchRpcClient(nodeUrl: string) {
  const provider = new RpcConnection(nodeUrl);
  return ArchConnection(provider);
}

export async function waitForProcessedTransaction(params: {
  nodeUrl: string;
  txid: string;
  timeoutMs?: number;
  pollMs?: number;
}) {
  const arch = createArchRpcClient(params.nodeUrl);
  const timeoutMs = params.timeoutMs ?? 10_000;
  const pollMs = params.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const processed = await arch.getProcessedTransaction(params.txid).catch(() => undefined);
    if (processed) return processed;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return undefined;
}

/**
 * Get the best finalized blockhash from Arch RPC.
 * Falls back to best blockhash if finalized is not available.
 */
export async function getFinalizedBlockhash(nodeUrl: string): Promise<string> {
  const arch = createArchRpcClient(nodeUrl);
  try {
    // Try to call getBestFinalizedBlockHash if it exists
    if (typeof (arch as any).getBestFinalizedBlockHash === "function") {
      return await (arch as any).getBestFinalizedBlockHash();
    }
    // Method doesn't exist, fall back to best blockhash
    return await arch.getBestBlockHash();
  } catch (err: any) {
    // If finalized fails, fall back to best blockhash
    return await arch.getBestBlockHash();
  }
}

export async function submitArchTransaction(params: {
  nodeUrl: string;
  tx: RuntimeTransaction;
}) {
  const arch = createArchRpcClient(params.nodeUrl);
  return await arch.sendTransaction(params.tx);
}

/**
 * Parse an Arch account address (base58) into the 32-byte pubkey type expected by arch-sdk.
 */
export function parsePubkey(pubkeyBase58: string): Uint8Array {
  return new Uint8Array(bs58.decode(pubkeyBase58));
}
