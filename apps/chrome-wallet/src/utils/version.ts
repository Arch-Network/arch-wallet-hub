/**
 * App version, surfaced in Settings + as a Sentry tag. Comes from the
 * WXT build-time env (`WXT_APP_VERSION`), injected from package.json
 * by `wxt.config.ts`.
 */

const buildVersion = ((import.meta as any)?.env?.WXT_APP_VERSION as string | undefined) ?? "";

export const APP_VERSION = buildVersion || "0.0.0";
