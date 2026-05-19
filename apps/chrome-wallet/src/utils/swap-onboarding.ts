/**
 * Wallet-side glue for `@arch/swap-engine`'s onboarding + faucet helpers.
 *
 * The engine ships `ensureOnboarding(config, pubkeyXCoord, signChallenge,
 * onPhase)` — an idempotent two-step that creates the user's Arch L2
 * account (if missing) and the supported-mint ATAs (if missing). It
 * expects a `SignChallenge = (challenge: string) => Promise<string>`
 * callback, which is the exact shape `makeSwapSigner` produces from our
 * wallet's `Signer`.
 *
 * We expose three pure helpers here so the React hook can stay focused
 * on state machinery:
 *
 *   - `ensureSwapOnboardingForAccount` — wraps `ensureOnboarding` with
 *     our active account + a BIP-322 simple-witness-shaped signer.
 *   - `probeAccountEligibility` — fast read-only check that decides
 *     whether the UI should show "Initialize" or proceed to swap.
 *   - `requestSwapFaucetForAccount` — testnet-only mint of all
 *     configured tokens for the active account.
 *
 * None of these touch React; they're directly testable against fixtures.
 */

import {
  ensureOnboarding,
  probeSwapAccountReadiness,
  requestFaucet,
  type NetworkConfig,
  type OnboardingPhase,
  type RequestFaucetResult,
  type SwapAccountReadiness,
} from "@arch/swap-engine";

import type { WalletAccount } from "../state/types";
import { walletStore } from "../state/wallet-store";
import {
  swapTransactionSignerForAccount,
  walletStateForEngine,
} from "./swap-engine";

/** Hex of an x-only pubkey (32 bytes / 64 lowercase hex chars). */
export type XOnlyPubkeyHex = string;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hexToBytes: odd-length input");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Read the engine's `WalletState.pubkeyXCoord` for the account. Centralises
 * the "strip the 02/03 byte from a compressed pubkey" normalisation so the
 * eligibility probe, onboarding call, and faucet call all agree on the
 * exact bytes being targeted.
 */
export function xOnlyPubkeyHexForAccount(account: WalletAccount): XOnlyPubkeyHex {
  return walletStateForEngine(account).pubkeyXCoord;
}

/**
 * Composite readiness: account is fee-payer-eligible AND every supported
 * mint has an ATA. The UI uses `isReady` to decide whether to render
 * the "Initialize for swaps" affordance.
 *
 * Why composite: a wallet may create the on-chain account via a non-
 * swap path (e.g. the Dashboard's ARCH airdrop button) without ever
 * touching the per-mint ATAs that swaps require. Eligibility alone
 * would falsely report "ready" in that state and the user would hit a
 * confusing faucet rejection on first swap attempt.
 *
 * Single-shot (no polling). Engine's `pollFeePayerEligibility` is
 * still the right tool for post-mutation confirmation polling.
 */
export async function probeAccountReadiness(
  account: WalletAccount,
  config: NetworkConfig,
): Promise<SwapAccountReadiness> {
  const pubkeyHex = xOnlyPubkeyHexForAccount(account);
  return probeSwapAccountReadiness(config, pubkeyHex);
}

export interface EnsureOnboardingInput {
  account: WalletAccount;
  config: NetworkConfig;
  onPhase?: (phase: OnboardingPhase) => void;
}

/**
 * Button-driven swap actions may run after the wallet password unlock
 * succeeded but the bounded Turnkey signing session expired or was never
 * opened. Re-open it at the signing boundary so retrying can recover with
 * a fresh passkey prompt instead of replaying SessionLockedError.
 */
export async function ensureSwapSigningSession(account: WalletAccount): Promise<void> {
  if (account.authMethod !== "passkey") {
    throw new Error("Swaps with email wallets are not supported yet.");
  }
  if (await walletStore.hasActiveSession()) return;
  await walletStore.openPasskeySession();
}

/**
 * Idempotent: probes eligibility, creates the account if needed, then
 * creates any missing ATAs. Triggers 1–2 passkey prompts depending on
 * what's missing. Throws with actionable copy on failure (the message is
 * surfaced verbatim in the UI's error banner).
 *
 * The `onPhase` callback receives the engine's lifecycle phases
 * (`checking-account` → `creating-account` → `verifying-account` →
 * `checking-token-accounts` → ...) — wire it into a stepper so the user
 * sees what's happening between passkey prompts.
 */
export async function ensureSwapOnboardingForAccount({
  account,
  config,
  onPhase,
}: EnsureOnboardingInput): Promise<void> {
  await ensureSwapSigningSession(account);
  const signChallenge = swapTransactionSignerForAccount(account);
  const pubkeyHex = xOnlyPubkeyHexForAccount(account);
  // `ensureOnboarding` itself handles the "already done" early-exit at
  // each step, so calling it on a fully-onboarded account is cheap (two
  // indexer reads and a verify) and never prompts the user.
  await ensureOnboarding(config, pubkeyHex, signChallenge, (phase) => {
    onPhase?.(phase);
  });
}

export interface RequestSwapFaucetInput {
  account: WalletAccount;
  /** Specific token to mint; omit to mint every configured token. */
  symbol?: Parameters<typeof requestFaucet>[0]["token"];
}

/**
 * Testnet-only. Mints faucet amounts for the configured token(s) into
 * the active account's ATAs.
 *
 * Important: the upstream faucet only emits `MintTo` and assumes the
 * ATA already exists. Callers MUST run `ensureSwapOnboardingForAccount`
 * first, or this will reject with
 * `FaucetRequestError { status: 500, message: "Error processing
 * Instruction 0, error: invalid account data for instruction" }`.
 *
 * On mainnet the engine throws `FaucetUnavailableError` (no faucetUrl is
 * configured). The hook surfaces that to the UI as "hide the button".
 */
export async function requestSwapFaucetForAccount({
  account,
  symbol,
}: RequestSwapFaucetInput): Promise<RequestFaucetResult> {
  const pubkeyHex = xOnlyPubkeyHexForAccount(account);
  return requestFaucet({
    userPubkeyHex: pubkeyHex,
    ...(symbol ? { token: symbol } : {}),
  });
}

// Re-export for ergonomic imports at call sites.
export { bytesToHex, hexToBytes };
