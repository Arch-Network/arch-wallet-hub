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

const isProd = ((import.meta as any)?.env?.MODE as string) === "production";

const prodKey =
  ((import.meta as any)?.env?.WXT_INDEXER_API_KEY as string | undefined) ?? "";
const devKey =
  ((import.meta as any)?.env?.WXT_INDEXER_API_KEY_DEV as string | undefined) ?? "";

export const DEFAULT_INDEXER_API_KEY = isProd ? prodKey : devKey || prodKey;
