/**
 * React state machine on top of `swap-onboarding.ts`. Owns:
 *
 *   1. Eligibility probe -- runs whenever the active account or network
 *      changes, and after any mutation (onboarding / faucet) so the UI
 *      can react to fresh on-chain state without callers having to
 *      explicitly invalidate.
 *
 *   2. `initialize()` -- runs the engine's idempotent onboarding flow
 *      and threads the live `OnboardingPhase` into local state for a
 *      stepper UI. Re-probes eligibility on completion.
 *
 *   3. `requestFunds(symbol?)` -- testnet-only faucet call. The result
 *      kind is preserved verbatim (single vs. batch) so the UI can
 *      compose the success toast with exact `txids`. Hides itself on
 *      mainnet via `faucetAvailable`.
 *
 * All callbacks are stable across renders for an unchanged account; the
 * hook avoids "spammy re-fetch" loops by gating the eligibility probe
 * on `(account?.id, network)` rather than full account object identity.
 *
 * NOT a singleton: each consumer (Swap page, Dashboard hero) gets its
 * own copy. The cost is two parallel probe requests at mount on the rare
 * page where both render simultaneously — acceptable for now; if it
 * becomes a problem, hoist into a tiny context provider.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FaucetRequestError,
  type NetworkConfig,
  type OnboardingPhase,
  type RequestFaucetResult,
  type SwapAccountReadiness,
  type TokenSymbol,
} from "@arch/swap-engine";

import type { NetworkId, WalletAccount } from "../state/types";
import { isFaucetConfiguredForNetwork } from "../utils/swap-engine";
import {
  ensureSwapOnboardingForAccount,
  probeAccountReadiness,
  requestSwapFaucetForAccount,
} from "../utils/swap-onboarding";

export type OnboardingStatus = "unknown" | "probing" | "ready" | "needs-onboarding" | "error";

export type FaucetStatus =
  | { kind: "idle" }
  | { kind: "running"; symbol?: TokenSymbol }
  | { kind: "success"; result: RequestFaucetResult; at: number }
  | { kind: "error"; message: string };

export interface UseArchOnboardingInput {
  account: WalletAccount | null;
  config: NetworkConfig;
  /** Wallet's UI-level network id. Drives both the probe-cache key
   *  (re-probe on flip) and the `faucetAvailable` derivation. */
  network: NetworkId;
}

export interface UseArchOnboardingReturn {
  status: OnboardingStatus;
  readiness: SwapAccountReadiness | null;
  /** Latest engine onboarding phase, while `initialize()` is running. */
  phase: OnboardingPhase | null;
  /** Reason text when `status === "error"`. */
  error: string | null;
  /** `true` while `initialize()` is in flight (mutually exclusive with
   *  faucet running -- the UI disables both buttons together). */
  isInitializing: boolean;
  faucet: FaucetStatus;
  /** True when the engine's transport config has a faucet URL (= testnet). */
  faucetAvailable: boolean;
  initialize: () => Promise<void>;
  requestFunds: (symbol?: TokenSymbol) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useArchOnboarding({
  account,
  config,
  network,
}: UseArchOnboardingInput): UseArchOnboardingReturn {
  const [readiness, setReadiness] = useState<SwapAccountReadiness | null>(null);
  const [status, setStatus] = useState<OnboardingStatus>("unknown");
  const [phase, setPhase] = useState<OnboardingPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const [faucet, setFaucet] = useState<FaucetStatus>({ kind: "idle" });
  const faucetAvailable = isFaucetConfiguredForNetwork(network);

  // Account identity proxy: rather than depend on the full WalletAccount
  // (which changes identity on any field mutation, e.g. balance refresh),
  // depend on the pubkey hex string -- the only field that matters for
  // probing on-chain state.
  const accountKey = account?.publicKeyHex ?? null;

  // Ref to bail out of stale async results when the user flips accounts
  // mid-probe. Tracking by a numeric token rather than account identity
  // means we don't have to thread the account object through closures.
  const probeTokenRef = useRef(0);

  const runProbe = useCallback(async () => {
    if (!account) {
      setStatus("unknown");
      setReadiness(null);
      return;
    }
    const myToken = ++probeTokenRef.current;
    setStatus("probing");
    setError(null);
    try {
      const result = await probeAccountReadiness(account, config);
      if (probeTokenRef.current !== myToken) return;
      setReadiness(result);
      setStatus(result.isReady ? "ready" : "needs-onboarding");
    } catch (e) {
      if (probeTokenRef.current !== myToken) return;
      // Keep this one error log -- probe failures are silent otherwise
      // and almost always indicate a transport (indexer) issue worth
      // surfacing in the console for triage.
      console.error("[ArchOnboarding] readiness probe failed", e);
      setStatus("error");
      setError(e instanceof Error ? e.message : "Eligibility probe failed");
    }
  }, [account, config]);

  // Re-probe whenever the *meaningful* identifying fields change.
  useEffect(() => {
    runProbe();
  }, [accountKey, network, runProbe]);

  const initialize = useCallback(async () => {
    if (!account || isInitializing) return;
    setIsInitializing(true);
    setPhase(null);
    setError(null);
    try {
      await ensureSwapOnboardingForAccount({
        account,
        config,
        onPhase: (p) => setPhase(p),
      });
      // Re-probe to confirm the chain agrees; `ensureOnboarding` already
      // polls for fee-payer eligibility internally, so this should be a
      // single read.
      await runProbe();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onboarding failed");
      setStatus("error");
    } finally {
      setIsInitializing(false);
      setPhase(null);
    }
  }, [account, config, isInitializing, runProbe]);

  const requestFunds = useCallback(
    async (symbol?: TokenSymbol) => {
      if (!account) return;
      setFaucet({ kind: "running", symbol });
      try {
        const result = await requestSwapFaucetForAccount({ account, symbol });
        setFaucet({ kind: "success", result, at: Date.now() });
        // Don't re-probe eligibility here -- the faucet doesn't change
        // fee-payer state. Callers refresh their own balances.
      } catch (e) {
        const msg =
          e instanceof FaucetRequestError
            ? `${e.message}${e.status ? ` (HTTP ${e.status})` : ""}`
            : e instanceof Error
              ? e.message
              : "Faucet request failed";
        setFaucet({ kind: "error", message: msg });
      }
    },
    [account],
  );

  return useMemo<UseArchOnboardingReturn>(
    () => ({
      status,
      readiness,
      phase,
      error,
      isInitializing,
      faucet,
      faucetAvailable,
      initialize,
      requestFunds,
      refresh: runProbe,
    }),
    [
      status,
      readiness,
      phase,
      error,
      isInitializing,
      faucet,
      faucetAvailable,
      initialize,
      requestFunds,
      runProbe,
    ],
  );
}

/**
 * Human-readable label for an OnboardingPhase. Centralised so the Swap
 * page and Dashboard hero render the same copy.
 */
export function labelForPhase(phase: OnboardingPhase): string {
  switch (phase) {
    case "checking-account":
      return "Checking your Arch account…";
    case "creating-account":
      return "Creating your Arch account (sign with passkey)…";
    case "verifying-account":
      return "Verifying account is live on-chain…";
    case "checking-token-accounts":
      return "Checking token accounts…";
    case "creating-token-accounts":
      return "Creating token accounts (sign with passkey)…";
    case "verifying-token-accounts":
      return "Verifying token accounts…";
  }
}
