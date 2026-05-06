/**
 * Build-time configuration for the Arch Explorer Indexer.
 *
 * The default Indexer API key is injected at build time via WXT/Vite env vars.
 * It is overridable by the user in Settings (`indexerApiKey` in wallet-store).
 *
 * The bundled default key is *not* a security boundary — it is rate-limited per
 * key on the server, and the user's wallet keys (passkey/Turnkey) are the
 * actual trust root. Treat it as a public-but-quota-limited token.
 */

export const INDEXER_BASE_URL = "https://explorer.arch.network/api/v1";

const buildEnvKey =
  ((import.meta as any)?.env?.WXT_INDEXER_API_KEY as string | undefined) ?? "";

const FALLBACK_INDEXER_API_KEY =
  "arch_live_28FvKem4QudQx0uczFunu4plqIo1rwWpiajtkrkj2PVhSllF";

export const DEFAULT_INDEXER_API_KEY = buildEnvKey || FALLBACK_INDEXER_API_KEY;
