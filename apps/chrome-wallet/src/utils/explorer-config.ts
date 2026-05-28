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

/**
 * Whether to talk to the Arch indexer DIRECTLY (legacy path) or
 * via the Wallet Hub's `/v1/indexer/*` proxy (default).
 *
 * Set at build time only:
 *   `WXT_USE_DIRECT_INDEXER=true npm run build:chrome`
 *
 * Default `false` -- new wallet releases route every indexer
 * call through the Hub, so the privileged indexer API key
 * never ships in the bundle. Flipping to `true` is the
 * emergency-rollback escape hatch: the legacy ArchIndexerClient
 * path (using `state.indexerApiKey || DEFAULT_INDEXER_API_KEY`)
 * still works and a re-released build gets users back to a
 * known-good direct path while we fix the Hub.
 *
 * Why build-time only (no runtime toggle):
 *   - Direct vs Hub is an internal wiring concern, not a user
 *     preference. Exposing it in Settings would invite users to
 *     footgun themselves into the 25-rps quota on the leaked
 *     key they have persisted.
 *   - Build-flag-only keeps the rollback path a one-line
 *     re-release, which is the cleanest possible operational
 *     story.
 */
declare const __ARCH_USE_DIRECT_INDEXER__: boolean;
export const USE_DIRECT_INDEXER: boolean =
  typeof __ARCH_USE_DIRECT_INDEXER__ === "boolean"
    ? __ARCH_USE_DIRECT_INDEXER__
    : false;
