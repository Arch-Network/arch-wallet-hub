/**
 * @arch/swap-engine -- the headless trading engine extracted from the
 * arch-swap web app, restructured so any host (chrome-wallet, future
 * dapps) can drive swaps without depending on Next.js, React, or
 * lasereyes.
 *
 * Wiring overview (for the wallet popup):
 *
 *     import { configureEngine, getAggregatedQuote, signAndSendTransaction,
 *              makeSwapSigner, TESTNET_CONFIG } from "@arch/swap-engine";
 *
 *     // Once, at app start (or whenever network changes):
 *     configureEngine({
 *       networkId: "testnet",
 *       transport: {
 *         indexerBaseUrl: "https://explorer.arch.network/api/v1/testnet",
 *         indexerApiKey: BUILD_TIME_INDEXER_KEY,
 *         propAmmQuoteUrl: "https://arch-swap-nine.vercel.app/api/propamm/quote",
 *       },
 *       prices: { getBtcUsdPrice: () => walletPrices.getBtcUsd() },
 *     });
 *
 *     // Per swap:
 *     const quote = await getAggregatedQuote(TESTNET_CONFIG, "aggregator",
 *       wallet, sellToken, buyToken, amount);
 *     const signer = makeSwapSigner(walletSigner);
 *     const txHash = await signAndSendTransaction(quote.runtimeTx, signer,
 *       { label: "Swap" });
 */

// Configuration / lifecycle
export {
  configureEngine,
  getEngineConfig,
  envDefaultNetworkId,
  isNetworkId,
  type EngineConfig,
  type EngineTransportConfig,
  type EnginePriceProvider,
  type NetworkId,
} from "./engine-config";

// Network configuration data (static)
export {
  getNetworkConfig,
  getTokenSymbols,
  getToken,
  mintHexForSymbol,
  resolveNetworkId,
  getClammProgramIdBytes,
  getLendingProgramIdBytes,
  lendingMarketByHex,
  curatorForMarketHex,
  getLendingMarkets,
  getLendingMarketAddresses,
  type Curator,
  type CuratorKey,
  type LendingMarket,
  type NetworkConfig,
  type PropAmmDeployment,
  type TokenInfo,
  type TokenSymbol,
} from "./lib/network/config";
export { TESTNET_CONFIG } from "./lib/network/testnet";
export { MAINNET_CONFIG } from "./lib/network/mainnet";

// Swap surface
export { getAggregatedQuote, getClammQuote } from "./lib/swap/router";
export { quoteSwap as quotePropAmmSwap } from "./lib/swap/quote-client";
export {
  QUOTE_TTL_MS,
  QUOTE_ONLY_PUBKEY,
  isQuoteFresh,
  applySlippage,
  type Quote,
  type Token,
} from "./lib/swap/types";

// Transaction submission
export {
  signAndSendTransaction,
  type TransactionSigner,
  type StatusCallback,
  type SignaturePlacement,
} from "./lib/arch/transaction-runner";
export {
  signRuntimeTransactionWithSigner,
  toSdkMessage,
} from "./lib/arch/signing";
export type {
  RuntimeMessage,
  RuntimeTransaction,
  AmmType,
  AmmMode,
} from "./lib/arch/types";

// Signer adapter -- the bridge from a wallet's local Signer to the
// callback shape arch-swap's transaction-runner expects. See
// `./signer-adapter.ts` for the lossy-round-trip caveat.
export { makeSwapSigner, type WalletDigestSigner } from "./signer-adapter";

// Wallet state shape
export type {
  WalletState,
  WalletIdentity,
  ConnectionPhase,
} from "./lib/wallet/types";

// Onboarding -- account + ATA creation. Idempotent; safe to call on every
// Swap page visit, but cheap enough that the wallet can probe eligibility
// first and skip the call entirely.
export {
  ensureOnboarding,
  type OnboardingPhase,
} from "./lib/wallet/onboarding";

// Eligibility probe (used by the wallet to decide whether to show the
// "Initialize for swaps" affordance vs. the swap submit button).
export {
  readFeePayerEligibility,
  pollFeePayerEligibility,
  classifyFeePayer,
  type FeePayerEligibility,
} from "./lib/arch/account-eligibility";

// Composite readiness probe (account + ATAs). Prefer this over
// `readFeePayerEligibility` when deciding whether to render the
// "Initialize for swaps" affordance, since a wallet may have created
// the user's account via a non-swap path (ARCH airdrop) without ever
// creating the per-mint ATAs that swaps require.
export {
  probeSwapAccountReadiness,
  type SwapAccountReadiness,
} from "./lib/wallet/readiness";

// Faucet -- testnet only. Throws FaucetUnavailableError on mainnet
// (no faucetUrl configured) so the host can hide the UI cleanly.
export {
  requestFaucet,
  FaucetUnavailableError,
  FaucetRequestError,
  type RequestFaucetInput,
  type RequestFaucetResult,
} from "./lib/wallet/faucet";

// Debug logger control (host can flip on/off at runtime)
export { configureDebugLogger, createDebugLogger } from "./lib/utils/debug-logger";
