import {
  ArchConnection,
  RpcConnection,
  SanitizedMessageUtil,
  SignatureUtil,
  type Instruction,
  type RuntimeTransaction
} from "@saturnbtcio/arch-sdk";
import { buildBip322ToSignPsbtBase64, extractBip322TaprootSignature64 } from "../bitcoin/bip322.js";
import type { TurnkeyService } from "../turnkey/client.js";

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
  const toSignPsbtBase64 = buildBip322ToSignPsbtBase64({
    signerAddress: params.build.signerBtcTaprootAddress,
    message: Buffer.from(messageHash)
  });

  const signed = await params.turnkey.signBitcoinTransaction({
    signWith: params.build.signerBtcTaprootAddress,
    unsignedTransaction: toSignPsbtBase64
  });

  const sig64 = extractBip322TaprootSignature64({
    signedTransaction: signed.signedTransaction
  });

  // Some client libs normalize the schnorr signature bytes; keep it explicit for Arch.
  const adjusted = SignatureUtil.adjustSignature(Uint8Array.from(sig64));

  return {
    runtimeTransaction: {
      version: 1,
      signatures: [adjusted],
      message
    },
    turnkeyActivityId: signed.activityId
  };
}

export type TurnkeyForArch = Pick<TurnkeyService, "signBitcoinTransaction">;

export function createArchRpcClient(nodeUrl: string) {
  const provider = new RpcConnection(nodeUrl);
  return ArchConnection(provider);
}

export async function submitArchTransaction(params: {
  nodeUrl: string;
  tx: RuntimeTransaction;
}) {
  const arch = createArchRpcClient(params.nodeUrl);
  return await arch.sendTransaction(params.tx);
}
