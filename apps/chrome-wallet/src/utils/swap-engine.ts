/**
 * Wallet-side glue for `@arch/swap-engine`. Owns the lifecycle of
 * `configureEngine(...)` (re-runs whenever the wallet's network or
 * indexer config changes) and exposes adapters for turning the wallet's
 * own primitives (`WalletAccount`, `Signer`, BTC price hook) into the
 * shapes the engine expects.
 *
 * Two surfaces consume this:
 *
 *   1. `Swap.tsx` -- calls `configureSwapEngineFromAppState` on mount
 *      and whenever the network changes, then uses
 *      `walletStateForEngine` + `digestSignerForAccount` to drive the
 *      engine.
 *
 *   2. Future flows that talk to the same engine (Lend, Borrow,
 *      Markets) -- so they all share one configuration entry point.
 *
 * The engine itself is stateless module config; calling
 * `configureEngine` is idempotent and cheap, so we don't track a
 * "configured" flag here. We just trade the latest snapshot in.
 */

import {
  configureEngine,
  TESTNET_CONFIG,
  MAINNET_CONFIG,
  type EngineConfig,
  type EnginePriceProvider,
  type NetworkConfig,
  type NetworkId as EngineNetworkId,
  type WalletState as EngineWalletState,
  type WalletDigestSigner,
  makeSwapSigner,
} from "@arch/swap-engine";

import type { AppState, NetworkId, WalletAccount } from "../state/types";
import { INDEXER_BASE_URL, DEFAULT_INDEXER_API_KEY } from "./explorer-config";
import { getBtcUsdPrice } from "./btc-price";
import { signerForAccount, type Signer } from "../signers/Signer";

/**
 * The wallet ships its PropAMM quote URL alongside the build for now.
 * In a follow-up we'll vendor PropAMM behind our own indexer (or move
 * to a multi-quoter), but for the initial in-wallet swap we just hit
 * the same endpoint the public arch-swap deployment uses.
 */
const PROPAMM_QUOTE_URL =
  "https://arch-swap-nine.vercel.app/api/propamm/quote";

/**
 * Testnet-only faucet URL. The upstream deployment is pinned to testnet
 * via its server-side cookie, so we leave this undefined on mainnet to
 * make `requestFaucet` throw a clean `FaucetUnavailableError` (the UI
 * uses that error to hide the "Get test funds" button entirely).
 */
const ARCH_SWAP_FAUCET_URL =
  "https://arch-swap-nine.vercel.app/api/faucet";

function toEngineNetworkId(network: NetworkId): EngineNetworkId {
  return network === "mainnet" ? "mainnet" : "testnet";
}

/**
 * Whether the configured engine for this wallet network has a faucet
 * endpoint. Today: testnet only. Used by the UI to gate the
 * "Get test funds" affordance without touching the engine's internals.
 */
export function isFaucetConfiguredForNetwork(network: NetworkId): boolean {
  return toEngineNetworkId(network) === "testnet";
}

/**
 * BTC price provider that always returns a finite, positive number --
 * the engine treats `<= 0` or `NaN` as a fatal error, and our wallet
 * intentionally hides USD on testnet. On testnet we fall back to a
 * stable sentinel so the engine's "compute USD-equivalent" branches
 * don't blow up; the popup just won't surface those values.
 */
function buildPriceProvider(): EnginePriceProvider {
  return {
    async getBtcUsdPrice() {
      const result = await getBtcUsdPrice();
      if (result.price && Number.isFinite(result.price) && result.price > 0) {
        return result.price;
      }
      // Sentinel value -- keeps engine math finite when the live feed is
      // unavailable (testnet, network down). UI code is expected to
      // ignore USD when it suspects this fallback was used.
      return 1;
    },
  };
}

export function buildEngineConfig(state: AppState): EngineConfig {
  const indexerBaseUrl = state.indexerBaseUrl || INDEXER_BASE_URL;
  const indexerApiKey = state.indexerApiKey || DEFAULT_INDEXER_API_KEY;
  const networkId = toEngineNetworkId(state.network);
  return {
    networkId,
    transport: {
      // The engine appends `/{network}/...` itself; our `INDEXER_BASE_URL`
      // already terminates at `/api/v1`, which is the prefix the engine
      // expects.
      indexerBaseUrl,
      indexerApiKey: indexerApiKey || undefined,
      propAmmQuoteUrl: PROPAMM_QUOTE_URL,
      // Mainnet has no faucet -- gate the URL on network so the engine's
      // `requestFaucet` throws cleanly there and the UI hides the affordance.
      faucetUrl: networkId === "testnet" ? ARCH_SWAP_FAUCET_URL : undefined,
    },
    prices: buildPriceProvider(),
    debugLogsEnabled: state.debugMode,
  };
}

/**
 * Tear down + reapply the engine module config for the current wallet
 * snapshot. Safe to call on every render that observes a relevant
 * field changing; the engine itself is module-state so this is fast.
 */
export function configureSwapEngineFromAppState(state: AppState): void {
  configureEngine(buildEngineConfig(state));
}

/**
 * Get the static network-data bundle the engine carries for the
 * wallet's currently selected network. Use this for token lookups and
 * pool metadata in the UI.
 */
export function getEngineNetworkConfig(network: NetworkId): NetworkConfig {
  return network === "mainnet" ? MAINNET_CONFIG : TESTNET_CONFIG;
}

/**
 * Build the engine's `WalletState` shape from the wallet's
 * `WalletAccount`. The engine's `pubkeyXCoord` is the bare 32-byte
 * x-only hex; our `publicKeyHex` may carry a 0x02/0x03 prefix, so
 * trim it.
 */
export function walletStateForEngine(
  account: WalletAccount,
): EngineWalletState {
  const xOnlyHex =
    account.publicKeyHex.length === 66
      ? account.publicKeyHex.slice(2)
      : account.publicKeyHex;
  return {
    pubkeyXCoord: xOnlyHex,
    taprootAddress: account.btcAddress,
    identity: {
      providerId:
        account.authMethod === "email"
          ? "wallet-hub-email-session"
          : "wallet-hub-passkey-session",
      providerLabel: account.label || "Arch Wallet",
    },
  };
}

/**
 * Build the engine-shaped signer for the given account. Delegates to
 * `signerForAccount`, which always routes through the per-device
 * IndexedDB session credential (post-P0 there's no parent-org
 * Hub-signing branch; bootstrap is what differs between passkey and
 * email wallets, and that happens before this signer is built).
 */
export function digestSignerForAccount(account: WalletAccount): WalletDigestSigner {
  const signer: Signer = signerForAccount(account);
  return signer;
}

/**
 * Convenience that yields the swap engine's
 * `TransactionSigner` (the BIP-322 witness-wrapped callback). Use this
 * directly with `signAndSendTransaction(quote.runtimeTx, signer, ...)`.
 */
export function swapTransactionSignerForAccount(account: WalletAccount) {
  return makeSwapSigner(digestSignerForAccount(account));
}
