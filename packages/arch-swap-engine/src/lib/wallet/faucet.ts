/**
 * Typed client for the arch-swap testnet faucet (`/api/faucet`).
 *
 * The upstream faucet emits a `MintTo` instruction signed by the configured
 * mint authority — it does NOT create the user account or the ATAs that
 * `MintTo` writes to. Callers must run `ensureOnboarding(...)` first;
 * otherwise the indexer returns "invalid account data for instruction".
 *
 * This module deliberately stays thin: no retry, no balance reconciliation,
 * no UI strings. The host owns retry semantics (the faucet's own
 * confirmation poll already runs server-side and waits up to ~30 s).
 *
 * Caveat: the faucet's network selection is server-side cookie-driven on
 * the upstream deployment. As long as the deployment we point at is the
 * testnet one (`arch-swap-nine.vercel.app`), `networkId === "testnet"`
 * round-trips correctly. Mainnet should not have a faucetUrl configured.
 */

import { getEngineConfig } from "@/engine-config";
import type { TokenSymbol } from "@/lib/network/config";

export class FaucetUnavailableError extends Error {
  constructor() {
    super(
      "Faucet is not available — engine transport.faucetUrl is not configured. " +
        "Set it in configureEngine({ transport: { faucetUrl } }) for testnet.",
    );
    this.name = "FaucetUnavailableError";
  }
}

export class FaucetRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "FaucetRequestError";
  }
}

export interface RequestFaucetInput {
  /** x-only pubkey hex (64 chars, lowercase preferred). */
  userPubkeyHex: string;
  /** Specific token to mint. Omit to mint every token configured for the network. */
  token?: TokenSymbol;
  /** Override the default atomic mint amount. Required when `token` is set if
   *  the upstream `single-token` response shape is desired. */
  amountAtoms?: bigint;
}

export type RequestFaucetResult =
  | { kind: "single"; minted: string; token: TokenSymbol; txids: string[] }
  | {
      kind: "batch";
      txids: string[];
      skipped?: Array<{ symbol: TokenSymbol; reason: string }>;
    };

/**
 * Hits the configured faucet URL and parses the response into a typed
 * discriminated union mirroring the two response shapes the upstream
 * endpoint returns.
 *
 * Throws:
 *   - `FaucetUnavailableError` when no `faucetUrl` is configured.
 *   - `FaucetRequestError` on non-2xx (carries upstream status + body).
 *   - `Error` on network failures.
 */
export async function requestFaucet(
  input: RequestFaucetInput,
): Promise<RequestFaucetResult> {
  const cfg = getEngineConfig();
  const url = cfg.transport.faucetUrl;
  if (!url) throw new FaucetUnavailableError();

  if (!/^[0-9a-fA-F]{64}$/.test(input.userPubkeyHex)) {
    throw new Error(
      "requestFaucet: userPubkeyHex must be a 64-char x-only pubkey hex string",
    );
  }

  // Upstream expects bigint as `number` in JSON. Within practical mint sizes
  // (~10^9–10^12 atoms) this stays inside JS Number safe range, but we
  // surface a clear error if a caller ever exceeds it rather than silently
  // truncating.
  let amount: number | undefined;
  if (input.amountAtoms !== undefined) {
    if (input.amountAtoms > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        "requestFaucet: amountAtoms exceeds Number.MAX_SAFE_INTEGER; " +
          "the upstream API encodes amount as a JSON number.",
      );
    }
    amount = Number(input.amountAtoms);
  }

  const body: Record<string, unknown> = { user_pubkey: input.userPubkeyHex };
  if (input.token) body.token = input.token;
  if (amount !== undefined) body.amount = amount;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep raw text in `parsed` for the error path; success path requires JSON.
  }

  if (!response.ok) {
    const msg =
      (parsed as { error?: string })?.error ??
      `Faucet returned HTTP ${response.status}`;
    throw new FaucetRequestError(msg, response.status, parsed);
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    "minted" in parsed &&
    "token" in parsed
  ) {
    const p = parsed as { minted: string; token: TokenSymbol; txids: string[] };
    return { kind: "single", minted: p.minted, token: p.token, txids: p.txids };
  }

  const p = parsed as {
    txids?: string[];
    skipped?: Array<{ symbol: TokenSymbol; reason: string }>;
  };
  return {
    kind: "batch",
    txids: p.txids ?? [],
    ...(p.skipped && p.skipped.length > 0 ? { skipped: p.skipped } : {}),
  };
}
