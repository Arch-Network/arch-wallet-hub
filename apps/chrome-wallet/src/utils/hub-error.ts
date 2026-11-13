/**
 * What the wallet knows about a Hub response that failed.
 *
 * Two things live here, both so that code stops reading meaning out of
 * error text. Error messages name paths, and a path holds an address or
 * a txid whose digits can spell any status.
 *
 *   - `HubIndexerError` carries the status as fields. The Hub SDK has
 *     its own `WalletHubError` for the routes it calls.
 *   - The request id of a recent failure can be looked up from the text
 *     an error banner shows, since the wallet's ~120 `setError(string)`
 *     calls keep the text and drop the error. Code that replaces the
 *     Hub's wording with its own says so with `rememberShownError`.
 *
 * Imports nothing, like `hub-rate-limit.ts`, which uses it.
 */

/** A read through the Hub's indexer proxy (`/v1/indexer/*`) that the Hub answered with an error. */
export class HubIndexerError extends Error {
  /** HTTP status of the Hub's response. */
  readonly status: number;
  /**
   * The status the indexer gave the Hub. The Hub answers 502 whenever
   * the indexer fails, so "not found" and "throttled" arrive here.
   */
  readonly upstreamStatus: number | undefined;
  /** The response's `x-request-id`: the id the Hub logged the request under. */
  readonly requestId: string | undefined;

  constructor(
    message: string,
    fields: { status: number; upstreamStatus?: number; requestId?: string },
  ) {
    super(message);
    this.name = "HubIndexerError";
    this.status = fields.status;
    this.upstreamStatus = fields.upstreamStatus;
    this.requestId = fields.requestId;
  }
}

/** The `message` of a Hub error body, or the body itself when it is not the Hub's JSON envelope. */
export function hubErrorBodyMessage(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    // Not JSON; the text is the message.
  }
  return bodyText;
}

/**
 * The status the indexer answered the Hub with. The Hub's proxy reports
 * it as `Indexer error <status> <statusText> (<url>): <body>`; only that
 * prefix is read, never the url or body after it.
 */
export function upstreamStatusOf(bodyMessage: string): number | undefined {
  const match = /^Indexer error (\d{3}) /.exec(bodyMessage);
  return match ? Number(match[1]) : undefined;
}

// ── Request ids for error banners ─────────────────────────────────────────

const RECENT_FAILURES_MAX = 20;
/** A failure older than this is not the reason for an error shown now. */
const RECENT_FAILURE_TTL_MS = 2 * 60_000;
/** The SDK cuts a body that is not JSON at this length before putting it in its message. */
const NEEDLE_MAX = 240;

interface RecentFailure {
  at: number;
  requestId: string;
  /** Text the thrown error's message contains. */
  needle: string;
}

const recentFailures: RecentFailure[] = [];

/** Keep a failed response's request id for `hubRequestIdFor`. */
export function rememberHubFailure(failure: { requestId: string; bodyMessage: string }): void {
  // Both Hub clients end their error message with the body's message.
  // A response without one is not kept: its status alone ("500") would
  // match unrelated text.
  const needle = failure.bodyMessage.slice(0, NEEDLE_MAX);
  if (!needle) return;
  recentFailures.push({ at: Date.now(), requestId: failure.requestId, needle });
  if (recentFailures.length > RECENT_FAILURES_MAX) recentFailures.shift();
}

/**
 * For code that shows its own wording for a failure: tie `shown` to the
 * request id of the first of `errors` that carries one.
 */
export function rememberShownError(shown: string, ...errors: unknown[]): void {
  for (const err of errors) {
    const requestId = err instanceof Error ? (err as { requestId?: unknown }).requestId : undefined;
    if (typeof requestId === "string" && requestId) {
      rememberHubFailure({ requestId, bodyMessage: shown });
      return;
    }
  }
}

/**
 * The request id of the latest recent Hub failure whose message `shown`
 * contains, if any. A screen that shows its own wording for a failure
 * gets none unless it called `rememberShownError`.
 */
export function hubRequestIdFor(shown: string): string | undefined {
  const oldest = Date.now() - RECENT_FAILURE_TTL_MS;
  for (let i = recentFailures.length - 1; i >= 0; i--) {
    const failure = recentFailures[i];
    if (failure.at < oldest) break;
    if (shown.includes(failure.needle)) return failure.requestId;
  }
  return undefined;
}
