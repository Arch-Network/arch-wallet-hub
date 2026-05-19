/**
 * Engine configuration — host-injected runtime knobs that replace
 * `process.env.NEXT_PUBLIC_*` and Next.js cookie reads in the upstream
 * arch-swap code.
 *
 * The chrome-wallet (or any other host) calls `configureEngine(...)` once
 * during initialization, passing the active network id, transport URLs,
 * and a price provider. Modules inside this package read the config via
 * `getEngineConfig()`; throwing if uninitialized makes the dependency
 * explicit instead of silently falling back to a default network.
 *
 * Why config rather than passing as a parameter through every call site:
 *   The arch-swap call graph is wide (50+ touch points across indexer /
 *   quote / clamm / runner). Module-scoped config matches arch-swap's
 *   own structure (their cookie-based resolution serves the same role)
 *   and avoids a noisy diff against upstream that would make future
 *   resyncs painful.
 *
 * Thread-safety note: the wallet is single-threaded JS, and we set the
 * config once at app start. If a host ever needs to switch networks at
 * runtime, call `configureEngine(...)` again with the new id — no other
 * synchronization is required.
 */

export type NetworkId = "testnet" | "mainnet";

export interface EngineTransportConfig {
  /**
   * Full base URL of the Arch Explorer indexer for the active network, e.g.
   * `https://explorer.arch.network/api/v1/testnet`. Trailing slash is stripped.
   * REST and RPC endpoints are constructed by appending `${path}` and `/rpc`
   * respectively.
   */
  indexerBaseUrl: string;
  /**
   * Optional `X-API-Key` header value. The Arch Explorer indexer requires this
   * for any meaningful traffic; pass the wallet's build-time key.
   */
  indexerApiKey?: string;
  /**
   * Full URL of the PropAMM quote endpoint, e.g.
   * `https://arch-swap-nine.vercel.app/api/propamm/quote`. Use the upstream's
   * CORS-* deployment so the popup can call it directly with no proxy.
   */
  propAmmQuoteUrl: string;
  /**
   * Optional full URL of the arch-swap faucet endpoint, e.g.
   * `https://arch-swap-nine.vercel.app/api/faucet`. Only meaningful on
   * testnet -- omit / leave undefined for mainnet. When unset, callers of
   * `requestFaucet(...)` get a `FaucetUnavailableError`.
   */
  faucetUrl?: string;
}

export interface EnginePriceProvider {
  /**
   * Returns BTC price in USD as a finite number. Called from `quote-client`
   * when the PropAMM response can't be parsed for exact amounts. The wallet
   * already has a unified price feed (`src/utils/prices.ts`), so pass that.
   */
  getBtcUsdPrice(): Promise<number>;
}

export interface EngineConfig {
  networkId: NetworkId;
  transport: EngineTransportConfig;
  prices: EnginePriceProvider;
  /** Whether to emit debug logs via `createDebugLogger`. */
  debugLogsEnabled?: boolean;
  /** Timeout for indexer + propamm fetches. Defaults to 8000 ms. */
  requestTimeoutMs?: number;
}

let currentConfig: EngineConfig | null = null;

export function configureEngine(config: EngineConfig): void {
  if (!config.transport?.indexerBaseUrl) {
    throw new Error("configureEngine: transport.indexerBaseUrl is required");
  }
  if (!config.transport?.propAmmQuoteUrl) {
    throw new Error("configureEngine: transport.propAmmQuoteUrl is required");
  }
  if (!config.prices?.getBtcUsdPrice) {
    throw new Error("configureEngine: prices.getBtcUsdPrice is required");
  }
  currentConfig = {
    ...config,
    transport: {
      ...config.transport,
      indexerBaseUrl: config.transport.indexerBaseUrl.replace(/\/+$/, ""),
    },
    requestTimeoutMs: config.requestTimeoutMs ?? 8_000,
    debugLogsEnabled: config.debugLogsEnabled ?? true,
  };
}

export function getEngineConfig(): EngineConfig {
  if (!currentConfig) {
    throw new Error(
      "@arch/swap-engine: configureEngine() must be called before any engine API. " +
        "See packages/arch-swap-engine/README or the chrome-wallet swap bootstrap for an example.",
    );
  }
  return currentConfig;
}

/** Convenience: backward-compatible network id accessor. */
export function envDefaultNetworkId(): NetworkId {
  return currentConfig?.networkId ?? "testnet";
}

/** Type guard mirrors the upstream `cookie.ts` export. */
export function isNetworkId(value: unknown): value is NetworkId {
  return value === "testnet" || value === "mainnet";
}
