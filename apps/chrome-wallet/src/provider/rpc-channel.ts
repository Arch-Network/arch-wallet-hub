/**
 * Shared RPC channel used by every injected provider (`arch`,
 * `bitcoin`, wallet-standard). Replaces the duplicated `sendRequest`
 * implementations in the per-protocol providers and centralizes the
 * window.postMessage hardenings:
 *
 *   - Outgoing messages target `window.location.origin` (no wildcard).
 *   - Incoming messages are filtered by `event.origin` and channel id.
 *   - A monotonic counter + random suffix guarantees unique request
 *     ids even when two providers race in the same tick.
 *   - The default timeout is 120 seconds with a single auto-retry if
 *     the SW restarted mid-request (Phase 3.4).
 */

const CHANNEL = "arch-wallet-provider";
const DEFAULT_TIMEOUT_MS = 120_000;

let counter = 0;
function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface RpcChannelOptions {
  /** Prefix used in generated request ids. Helps when debugging. */
  prefix?: string;
}

export class RpcChannel {
  private readonly prefix: string;
  private readonly pageOrigin: string;

  constructor(opts: RpcChannelOptions = {}) {
    this.prefix = opts.prefix ?? "rpc";
    this.pageOrigin = typeof window !== "undefined" ? window.location.origin : "";
  }

  async request<T = unknown>(type: string, payload?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const id = genId(this.prefix);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const handler = (event: MessageEvent) => {
        if (settled) return;
        if (event.source !== window) return;
        if (event.origin !== this.pageOrigin) return;
        if (event.data?.channel !== CHANNEL) return;
        if (event.data?.direction !== "to-page") return;
        if (event.data?.id !== id) return;

        const response = event.data.response;
        settled = true;
        window.removeEventListener("message", handler);
        clearTimeout(timer);

        if (response?.success) {
          resolve(response.data as T);
        } else {
          reject(new Error(response?.error ?? "Request failed"));
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", handler);
        reject(new Error("Request timed out"));
      }, timeoutMs);

      window.addEventListener("message", handler);
      window.postMessage(
        { channel: CHANNEL, direction: "to-extension", payload: { type, id, payload } },
        this.pageOrigin,
      );
    });
  }
}
