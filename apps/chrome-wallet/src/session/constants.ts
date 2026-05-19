/**
 * Turnkey public API base URL. The IndexedDB stamper signs every
 * request that goes to this host with the per-device session API
 * key, so we never need to put a long-lived secret on the Hub.
 */
export const TURNKEY_API_BASE_URL = "https://api.turnkey.com";

/**
 * Floor for any session TTL. autoLockMinutes can be set lower by
 * advanced users, but anything under 60s makes the session
 * effectively unusable (a single sign + a UI confirmation can
 * easily eat that window). We clamp here in one place so the
 * bootstrap helpers and the lifecycle wiring agree.
 */
export const MIN_SESSION_TTL_SECONDS = 60;

/**
 * Ceiling for a session TTL. Turnkey accepts arbitrarily large
 * expirationSeconds values but giving an unattended browser an
 * eight-hour signing key is exactly the failure mode we're trying
 * to avoid by moving away from per-tx prompts; keep it bounded.
 */
export const MAX_SESSION_TTL_SECONDS = 4 * 60 * 60; // 4 hours

/**
 * Slack window: when a stored session is within this many seconds
 * of expiry we treat it as already expired so we don't serve a
 * client that will fail mid-operation.
 */
export const SESSION_EXPIRY_SLACK_SECONDS = 30;
