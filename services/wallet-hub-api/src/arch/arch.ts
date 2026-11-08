import {
  ArchConnection,
  RpcConnection,
  type RuntimeTransaction
} from "@arch-network/arch-sdk";
import bs58 from "bs58";

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
