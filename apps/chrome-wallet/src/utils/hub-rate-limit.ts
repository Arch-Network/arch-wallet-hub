/**
 * Client-side handling of Wallet Hub 429s.
 *
 * One cooldown per route group, the first path segment after `/v1`
 * (`indexer`, `auth`, `recovery`, `signing-requests`, ...), not one for
 * the whole Hub: the Hub limits indexer reads per install, session mint
 * and recovery per IP, and everything else per app key + IP, each in its
 * own bucket. A throttled indexer must not block a session mint or a
 * signing request, and an IP-wide auth limit must not freeze balances.
 * Groups that share the Hub's default bucket each pay at most one 429
 * before failing fast too.
 *
 * While a group's cooldown runs, its calls fail fast locally with
 * `HubRateLimitError` instead of reaching the network. Consecutive 429s
 * back off exponentially with jitter, never sooner than the Hub asked
 * unless that exceeds the one-minute cap. State is per extension context
 * (popup, side panel, service worker) and is not persisted.
 *
 * Deliberately dependency-free so both the indexer client and the SDK
 * client wiring in `sdk.ts` can import it without a cycle.
 */

/** Cooldown when the 429 carries no usable header; doubles per consecutive 429. */
const BASE_COOLDOWN_MS = 5_000;
const MAX_COOLDOWN_MS = 60_000;
/** Up to +25%, so contexts and installs sharing an IP don't resume in lockstep. */
const JITTER_RATIO = 0.25;

export class HubRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Wallet Hub rate limit: retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "HubRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

interface Cooldown {
  until: number;
  consecutive429s: number;
}

const cooldowns = new Map<string, Cooldown>();

export function hubRouteGroup(url: string): string {
  return /\/v1\/([^/?#]+)/.exec(url)?.[1] ?? "";
}

/**
 * The wait the Hub asked for, in ms: `retry-after`, else
 * `x-ratelimit-reset`. The Hub sends both as seconds until its window
 * ends, not as timestamps.
 */
export function parseRetryAfterMs(headers: Headers): number | null {
  for (const name of ["retry-after", "x-ratelimit-reset"]) {
    const raw = headers.get(name)?.trim();
    if (!raw) continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return null;
}

/** Cooldown for the `attempt`-th consecutive 429 (1-based). */
export function cooldownMs(
  attempt: number,
  serverMs: number | null,
  random: () => number = Math.random,
): number {
  const backoff = BASE_COOLDOWN_MS * 2 ** (attempt - 1);
  const wait = Math.max(serverMs ?? 0, backoff) * (1 + random() * JITTER_RATIO);
  return Math.min(MAX_COOLDOWN_MS, wait);
}

export function hubCooldownRemainingMs(group: string, now = Date.now()): number {
  return Math.max(0, (cooldowns.get(group)?.until ?? 0) - now);
}

/**
 * Record a 429 and return the error to throw. 429s from requests that
 * were already in flight when the cooldown started neither extend it
 * nor count as another consecutive 429.
 */
function noteRateLimited(group: string, headers: Headers): HubRateLimitError {
  const now = Date.now();
  const cooldown = cooldowns.get(group) ?? { until: 0, consecutive429s: 0 };
  if (now >= cooldown.until) {
    cooldown.consecutive429s += 1;
    cooldown.until = now + cooldownMs(cooldown.consecutive429s, parseRetryAfterMs(headers));
    cooldowns.set(group, cooldown);
  }
  return new HubRateLimitError(cooldown.until - now);
}

/**
 * `fetchImpl` gated by the request's route-group cooldown: throws
 * `HubRateLimitError` without a network call while it runs, and on a 429.
 */
export async function fetchWithHubRateLimit(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const group = hubRouteGroup(url);
  const remaining = hubCooldownRemainingMs(group);
  if (remaining > 0) throw new HubRateLimitError(remaining);
  const res = await fetchImpl(input, init);
  if (res.status === 429) throw noteRateLimited(group, res.headers);
  if (res.ok && hubCooldownRemainingMs(group) === 0) cooldowns.delete(group);
  return res;
}

/**
 * `fetchImpl` for the Wallet Hub SDK client. The SDK rewraps anything
 * fetch throws as "WalletHub network error: …", which `hubRetryAfterMs`
 * still reads.
 */
export function hubRateLimitedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetchWithHubRateLimit(fetch, input, init);
}

/** The delay a Hub rate-limit error carries, or null for any other error. */
export function hubRetryAfterMs(err: unknown): number | null {
  if (err instanceof HubRateLimitError) return err.retryAfterMs;
  const message = err instanceof Error ? err.message : String(err ?? "");
  const match = /Wallet Hub rate limit: retry in (\d+)s/.exec(message);
  return match ? Number(match[1]) * 1000 : null;
}

export function isHubRateLimitError(err: unknown): boolean {
  return hubRetryAfterMs(err) !== null;
}
