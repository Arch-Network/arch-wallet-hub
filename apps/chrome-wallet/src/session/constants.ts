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
 * expirationSeconds values but giving an unattended browser a
 * multi-hour signing key is exactly the failure mode we're trying
 * to avoid by moving away from per-tx prompts; keep it bounded.
 *
 * Reduced from 4h -> 1h in the 2026-05 hardening pass. The old
 * 4-hour ceiling meant a single passkey tap unlocked silent signing
 * for half a workday, which is unacceptable for a stolen-device or
 * malicious-extension threat model.
 */
export const MAX_SESSION_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * WebAuthn relying-party id used for ALL passkey ceremonies.
 *
 * Hosted https / mobile associated-domains RP. Extension documents
 * cannot use this value: password managers compare rpId to the page
 * origin and will refuse `wallet.arch.network` from
 * `chrome-extension://<id>/`. Call `effectivePasskeyRpId()` at the
 * ceremony so the extension id is used in the popup / side panel and
 * this constant is used on the hosted wallet origin.
 *
 * In production this is `wallet.arch.network`. In dev it is
 * `localhost`. The choice is driven by `import.meta.env.MODE`.
 */
const PASSKEY_RP_ID_PROD = "wallet.arch.network";
const PASSKEY_RP_ID_DEV = "localhost";
const isProdBuild =
  ((import.meta as any)?.env?.MODE as string | undefined) === "production";
export const PASSKEY_RP_ID = isProdBuild ? PASSKEY_RP_ID_PROD : PASSKEY_RP_ID_DEV;

/**
 * Slack window: when a stored session is within this many seconds
 * of expiry we treat it as already expired so we don't serve a
 * client that will fail mid-operation.
 */
export const SESSION_EXPIRY_SLACK_SECONDS = 30;
