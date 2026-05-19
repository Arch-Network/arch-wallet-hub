/**
 * Debug Logger
 *
 * Structured logging utility for tracing swap transactions, RPC calls,
 * quote routing, and confirmation polling across the app.
 *
 * All output is gated by a single kill-switch so logs can be silenced
 * in production without removing call-sites.
 *
 * ## Disabling logs
 *
 * **At build time (recommended for production):**
 *   Set `NEXT_PUBLIC_DEBUG_LOGS=false` in your `.env` / `.env.production`.
 *
 * **At runtime (useful for on-the-fly debugging in staging/prod):**
 *   From the browser console:
 *   ```js
 *   import("@/utils/debug-logger").then(m => m.configureDebugLogger({ enabled: false }));
 *   ```
 *   Or call `configureDebugLogger({ enabled: false })` in a top-level provider.
 *
 * Logs are **enabled by default** unless the env var is explicitly `"false"`.
 *
 * ## Usage
 *
 * ```ts
 * import { createDebugLogger } from "@/utils/debug-logger";
 *
 * const logger = createDebugLogger("Swap");
 *
 * logger.log("TX_SUBMITTED", { txHash, durationMs });
 * logger.warn("SDK_FALLBACK", { error: err.message });
 * logger.error("TX_FAILED", { txHash, reason });
 * ```
 *
 * Output format: `[Tag][2026-04-14T12:00:00.000Z] STAGE { ...data }`
 */

type LogLevel = "log" | "warn" | "error";

type DebugLoggerConfig = {
  enabled: boolean;
};

// Default OFF — extension hosts opt in via `configureEngine({ debugLogsEnabled: true })`
// and we surface a runtime override below for live debugging from devtools.
const globalConfig: DebugLoggerConfig = {
  enabled: false,
};

/**
 * Override the global debug logger configuration at runtime.
 * Affects all loggers created via `createDebugLogger`.
 */
export function configureDebugLogger(config: Partial<DebugLoggerConfig>) {
  Object.assign(globalConfig, config);
}

function emit(level: LogLevel, tag: string, stage: string, data?: unknown) {
  if (!globalConfig.enabled) return;
  const ts = new Date().toISOString();
  const prefix = `[${tag}][${ts}] ${stage}`;
  if (data !== undefined) {
    console[level](prefix, data);
  } else {
    console[level](prefix);
  }
}

/**
 * Create a tagged logger instance. The tag is prepended to every log line
 * so output can be filtered in the browser console (e.g. `[Swap]`, `[ArchRPC]`).
 */
export function createDebugLogger(tag: string) {
  return {
    log: (stage: string, data?: unknown) => emit("log", tag, stage, data),
    warn: (stage: string, data?: unknown) => emit("warn", tag, stage, data),
    error: (stage: string, data?: unknown) => emit("error", tag, stage, data),
  };
}
