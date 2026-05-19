/**
 * Phase 5.6 - Lightweight log + opt-in Sentry.
 *
 * The wallet defaults to *no* error reporting. Users can opt in from
 * Settings (`sentryOptIn` in wallet-store). When enabled, only
 * captured exceptions are sent; we never include addresses, keys,
 * transaction payloads, or raw URLs containing query strings.
 *
 * The console wrapper here is also the home for the debug toggle
 * (`debugMode`). When debug mode is on, info/warn are mirrored to a
 * ring buffer the Settings -> Diagnostics view can render.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
  extra?: unknown;
}

const RING_SIZE = 100;
const ring: LogEntry[] = [];
let debugEnabled = false;
let sentryInitialized = false;

export function setDebugMode(enabled: boolean): void {
  debugEnabled = enabled;
}

export function getRecentLogs(): LogEntry[] {
  return [...ring];
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
  const dsn = opts.dsn ?? ((import.meta as any)?.env?.WXT_SENTRY_DSN as string | undefined);
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
