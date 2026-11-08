import { classifyProviderError } from "./errors";
import type { BridgeRequest, BridgeResponse } from "./protocol";
import { unisatConnect, unisatSign } from "./unisat";
import { xverseConnect, xverseSign } from "./xverse";

const LABELS = { xverse: "Xverse", unisat: "UniSat" } as const;

/** Run one bridge request in the connector page and report a typed result. */
export async function handleBridgeRequest(req: BridgeRequest): Promise<BridgeResponse> {
  const label = LABELS[req.provider] ?? "The wallet";
  try {
    let data: unknown;
    if (req.provider === "xverse") {
      data = req.method === "connect" ? await xverseConnect(req.args.network) : await xverseSign(req);
    } else if (req.provider === "unisat") {
      data = req.method === "connect" ? await unisatConnect(req.args.network) : await unisatSign(req);
    } else {
      return { success: false, code: "UNSUPPORTED", error: `Unsupported wallet: ${String((req as any).provider)}` };
    }
    return { success: true, data };
  } catch (err) {
    const e = classifyProviderError(err, label);
    return { success: false, error: e.message, code: e.code };
  }
}
