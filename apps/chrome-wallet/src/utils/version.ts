/**
 * App version, surfaced in Settings + as a Sentry tag. Comes from the
 * WXT build-time env (`WXT_APP_VERSION`, injected from package.json
 * via vite define). Falls back to the package.json string for dev
 * builds that don't set the env explicitly.
 */

const buildVersion = ((import.meta as any)?.env?.WXT_APP_VERSION as string | undefined) ?? "";

// Keep in sync with package.json. If you update one, update the other.
const PACKAGE_VERSION_FALLBACK = "0.2.0";

export const APP_VERSION = buildVersion || PACKAGE_VERSION_FALLBACK;
