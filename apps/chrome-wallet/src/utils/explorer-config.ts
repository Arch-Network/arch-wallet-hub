/**
 * Build-time configuration for the Arch Explorer Indexer.
 *
 * The Indexer API key is injected at build time via WXT/Vite env vars.
 * It is overridable by the user in Settings (`indexerApiKey` in
 * wallet-store). No production-bound default is shipped in source; dev
 * builds use WXT_INDEXER_API_KEY_DEV, release builds use
 * WXT_INDEXER_API_KEY. If neither is set we fall back to an empty
 * string and the user is prompted to enter one on first run.
 *
 * Treat the key as a public-but-quota-limited token. The actual trust
 * root is the user's wallet keys (passkey/Turnkey).
 */

export const INDEXER_BASE_URL = "https://explorer.arch.network/api/v1";

// Build-time indexer key is injected via `vite.define` (see wxt.config.ts).
// `import.meta.env.WXT_INDEXER_API_KEY` substitution is unreliable in CI
// Vite 8/Rolldown builds (see comments in src/state/types.ts).
declare const __ARCH_BUILD_INDEXER_API_KEY__: string;
const prodKey: string = __ARCH_BUILD_INDEXER_API_KEY__ || "";
const devKey: string =
  ((import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.WXT_INDEXER_API_KEY_DEV as string | undefined) ?? "";
const isProd =
  ((import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.MODE as string | undefined) === "production";

export const DEFAULT_INDEXER_API_KEY = isProd ? prodKey : devKey || prodKey;
