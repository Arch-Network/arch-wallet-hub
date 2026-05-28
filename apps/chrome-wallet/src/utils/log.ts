/**
 * Lightweight wallet-side logger + opt-in Sentry.
 *
 * The wallet defaults to *no* error reporting. Users can opt in from
 * Settings -> Diagnostics. When enabled, only captured exceptions are
 * sent; we never include addresses, keys, transaction payloads, or
 * raw URLs containing query strings (see `sanitize`).
 *
 * Verbose mode (`debugMode`) is also wired here: when on, info/debug
 * are mirrored to a small ring buffer the Settings Diagnostics view
 * renders, and to `console.*` so the SW DevTools see the same output.
 *
 * Boot-time wiring (`applyDiagnosticsRuntime`) lives at the bottom of
 * this file; every entry point (popup, background SW) calls it once
 * after loading the persisted wallet state and again whenever the
 * user flips a Diagnostics toggle. The wallet-store setters call
 * through too, so a toggle change takes effect immediately in the
 * same JS realm instead of waiting for a storage round-trip.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
  extra?: unknown;
}

const RING_SIZE = 100;
const ring: LogEntry[] = [];
let debugEnabled = false;
let sentryInitialized = false;
let globalHandlersInstalled = false;

export function setDebugMode(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebugModeEnabled(): boolean {
  return debugEnabled;
}

export function isSentryActive(): boolean {
  return sentryInitialized;
}

export function getRecentLogs(): LogEntry[] {
  return [...ring];
}

export function clearRecentLogs(): void {
  ring.length = 0;
}

function push(entry: LogEntry): void {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
}

/**
 * Sanitize an arbitrary payload before it leaves the device. Removes
 * fields that look like keys, mnemonics, addresses, or arbitrary
 * hex/base64 blobs. The result is suitable for breadcrumbs but not
 * for full payload capture.
 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (/^[0-9a-fA-F]{40,}$/.test(value)) return `[hex:${value.length}]`;
    if (/^[A-Za-z0-9+/=]{40,}$/.test(value)) return `[b64:${value.length}]`;
    if (value.length > 200) return `${value.slice(0, 80)}...[truncated]`;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 16).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as object)) {
      if (/(seed|mnemonic|password|secret|privkey|private_key|api_key|signature|psbt)/i.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export const log = {
  debug(msg: string, extra?: unknown) {
    if (!debugEnabled) return;
    const entry: LogEntry = { ts: Date.now(), level: "debug", msg, extra: sanitize(extra) };
    push(entry);
    console.debug("[arch-wallet]", msg, extra);
  },
  info(msg: string, extra?: unknown) {
    const entry: LogEntry = { ts: Date.now(), level: "info", msg, extra: sanitize(extra) };
    push(entry);
    if (debugEnabled) console.info("[arch-wallet]", msg, extra);
  },
  warn(msg: string, extra?: unknown) {
    const entry: LogEntry = { ts: Date.now(), level: "warn", msg, extra: sanitize(extra) };
    push(entry);
    console.warn("[arch-wallet]", msg, extra);
  },
  error(msg: string, err?: unknown) {
    const safeExtra = err instanceof Error ? { name: err.name, message: err.message } : sanitize(err);
    const entry: LogEntry = { ts: Date.now(), level: "error", msg, extra: safeExtra };
    push(entry);
    console.error("[arch-wallet]", msg, err);
    if (sentryInitialized) {
      try {
        const sentry = (globalThis as any).Sentry;
        sentry?.captureException?.(err instanceof Error ? err : new Error(msg));
      } catch {
        /* never let logging cause a re-throw */
      }
    }
  },
};

/**
 * Bootstrap Sentry only when the user opts in. The actual Sentry SDK
 * is loaded dynamically so users who never opt in pay zero bundle
 * cost. The integration captures unhandled errors only -- no
 * breadcrumbs, no replays, no performance tracing.
 */
export async function maybeInitSentry(opts: { enabled: boolean; dsn?: string; release?: string }): Promise<void> {
  if (!opts.enabled || sentryInitialized) return;
  const dsn = opts.dsn ?? resolveBuildTimeSentryDsn();
  if (!dsn) return;
  try {
    // Loaded dynamically + as a string literal so users who never opt in pay
    // zero bundle cost. Cast to any so the type system doesn't require the
    // optional dep at compile time.
    const sentry: any = await import(/* @vite-ignore */ ("@sentry/browser" as any)).catch(() => null);
    if (!sentry) return;
    sentry.init({
      dsn,
      release: opts.release,
      sampleRate: 1.0,
      tracesSampleRate: 0,
      beforeSend(event: any) {
        // Defense-in-depth: strip request data and breadcrumbs that
        // might have slipped through.
        if (event.request) event.request = undefined;
        if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.slice(-5);
        return event;
      },
    });
    (globalThis as any).Sentry = sentry;
    sentryInitialized = true;
  } catch {
    /* offline / blocked -- swallow silently */
  }
}

/**
 * Build-time DSN injected via `WXT_SENTRY_DSN`. Resolved at call
 * time (not module init) so test environments can stub it via
 * `vitest.config` defines. Returns `undefined` when not configured;
 * `maybeInitSentry` short-circuits cleanly in that case, and the
 * Settings UI hides the opt-in toggle entirely.
 */
export function resolveBuildTimeSentryDsn(): string | undefined {
  const env = (import.meta as any)?.env;
  if (env && typeof env.WXT_SENTRY_DSN === "string" && env.WXT_SENTRY_DSN.length > 0) {
    return env.WXT_SENTRY_DSN as string;
  }
  return undefined;
}

/**
 * True iff this build was compiled with a Sentry DSN. Surfaced to
 * the Settings UI so we can hide the opt-in toggle in builds that
 * physically cannot ship reports anywhere -- otherwise the toggle
 * would look broken when it's actually doing exactly what it's told.
 */
export function isSentryAvailableForOptIn(): boolean {
  return typeof resolveBuildTimeSentryDsn() === "string";
}

/**
 * Bridge persisted Diagnostics state into the runtime log/Sentry
 * machinery. Safe to call repeatedly:
 *
 *   - Debug-mode flips are a single assignment.
 *   - Sentry opt-in initializes lazily; subsequent calls with
 *     `sentryOptIn: true` are no-ops once initialized.
 *   - Sentry opt-out flips `sentryInitialized = false` so future
 *     errors stop being forwarded; the loaded SDK module stays in
 *     memory (we can't unload it cleanly), but no events emit.
 *
 * Callers: `wallet-store.setDebugMode/setSentryOptIn` (immediate
 * effect on the writing realm), popup `App.tsx` boot-time effect,
 * background SW `syncDiagnosticsFromStorage` at module init + on
 * storage-onChanged. All paths use the same args shape, so the
 * contract stays one function.
 */
export function applyDiagnosticsRuntime(opts: {
  debugMode: boolean;
  sentryOptIn: boolean;
  release?: string;
}): void {
  setDebugMode(!!opts.debugMode);

  if (opts.sentryOptIn && isSentryAvailableForOptIn()) {
    // Fire-and-forget: opt-in users tolerate a one-tick delay before
    // captures actually leave the device. We don't await here so
    // boot paths stay synchronous.
    void maybeInitSentry({ enabled: true, release: opts.release });
  } else if (!opts.sentryOptIn) {
    // The user opted out (or never opted in). Stop forwarding.
    sentryInitialized = false;
  }
}

interface GlobalEventTargetLike {
  addEventListener: (
    type: string,
    listener: (event: any) => void,
    options?: { capture?: boolean },
  ) => void;
  removeEventListener: (
    type: string,
    listener: (event: any) => void,
    options?: { capture?: boolean },
  ) => void;
}

/**
 * Wire `error` + `unhandledrejection` listeners on a global target
 * (window in the popup, self in the SW) so uncaught exceptions reach
 * `log.error` -- which is the only path that forwards to Sentry. Most
 * code in the wallet calls `console.error` directly or just throws;
 * without this hook, `sentryOptIn = true` would never see those.
 *
 * Idempotent across calls. Returns a teardown for tests.
 */
export function installGlobalErrorHandlers(target: GlobalEventTargetLike): () => void {
  if (globalHandlersInstalled) return () => {};

  const onError = (event: any) => {
    // `ErrorEvent` carries the original Error in `event.error`; some
    // synthetic events only have `message` + `filename` + `lineno`.
    const err = event?.error ?? new Error(event?.message ?? "Uncaught error");
    log.error("uncaught error", err);
  };

  const onRejection = (event: any) => {
    const reason = event?.reason;
    const err = reason instanceof Error ? reason : new Error(String(reason ?? "Unhandled rejection"));
    log.error("unhandled promise rejection", err);
  };

  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  globalHandlersInstalled = true;

  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    globalHandlersInstalled = false;
  };
}

/**
 * Test-only reset. Wired through here rather than via direct module
 * mutation so the test-private surface stays explicit.
 */
export function __resetForTests(): void {
  ring.length = 0;
  debugEnabled = false;
  sentryInitialized = false;
  globalHandlersInstalled = false;
  delete (globalThis as any).Sentry;
}
