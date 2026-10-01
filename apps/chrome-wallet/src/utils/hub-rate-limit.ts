/**
 * Client-side handling of Wallet Hub 429s.
 *
 * One cooldown for the whole Hub (per extension context), not per route:
 * the Hub's limiter keys a single bucket on app key + client IP across
 * every route, so once one route returns 429 the others would too. While
 * the cooldown runs, Hub calls fail fast locally with `HubRateLimitError`
 * instead of reaching the network. Consecutive 429s back off
 * exponentially with jitter, never sooner than the Hub asked, capped at
 * a minute.
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

let cooldownUntil = 0;
let consecutive429s = 0;

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

export function hubCooldownRemainingMs(now = Date.now()): number {
  return Math.max(0, cooldownUntil - now);
}

/** Throw while a cooldown runs, before any network call. */
export function assertHubAvailable(): void {
  const remaining = hubCooldownRemainingMs();
  if (remaining > 0) throw new HubRateLimitError(remaining);
}

/**
 * Record a 429 and return the error to throw. 429s from requests that
 * were already in flight when the cooldown started neither extend it
 * nor count as another consecutive 429.
 */
export function noteHubRateLimited(headers: Headers): HubRateLimitError {
  const now = Date.now();
  if (now >= cooldownUntil) {
    consecutive429s += 1;
    cooldownUntil = now + cooldownMs(consecutive429s, parseRetryAfterMs(headers));
  }
  return new HubRateLimitError(cooldownUntil - now);
}

export function noteHubSuccess(): void {
  if (Date.now() >= cooldownUntil) consecutive429s = 0;
}

/**
 * `fetchImpl` for the Wallet Hub SDK client. The SDK rewraps anything
 * fetch throws as "WalletHub network error: …" and a 429 response as
 * "WalletHub error 429 …"; `isHubRateLimitError` recognizes both.
 */
export async function hubRateLimitedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  assertHubAvailable();
  const res = await fetch(input, init);
  if (res.status === 429) noteHubRateLimited(res.headers);
  else if (res.ok) noteHubSuccess();
  return res;
}

export function isHubRateLimitError(err: unknown): boolean {
  if (err instanceof HubRateLimitError) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /\bWalletHub error 429\b/.test(message) || message.includes("Wallet Hub rate limit:");
}

/** Epoch ms the running Hub cooldown ends, or null when none is running. */
export function hubCooldownEndsAt(): number | null {
  return cooldownUntil > Date.now() ? cooldownUntil : null;
}
