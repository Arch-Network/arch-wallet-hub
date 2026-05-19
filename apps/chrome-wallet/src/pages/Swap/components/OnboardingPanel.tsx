/**
 * Renders the "Initialize for swaps" affordance plus a live phase
 * stepper while onboarding is in progress.
 *
 * Lives above the swap form on the Swap page when the active account
 * fails the validator's structural fee-payer check. It owns no state of
 * its own — drives entirely off the `useArchOnboarding` hook's outputs.
 *
 * Hidden when `status === "ready"`. When `status === "needs-onboarding"`
 * it surfaces the eligibility reason in plain language so users
 * understand *why* an extra step is required before they can swap.
 */
import type { ReactNode } from "react";
import type { OnboardingPhase, SwapAccountReadiness } from "@arch/swap-engine";

import { labelForPhase } from "../../../hooks/useArchOnboarding";

type Props = {
  status: "unknown" | "probing" | "ready" | "needs-onboarding" | "error";
  readiness: SwapAccountReadiness | null;
  phase: OnboardingPhase | null;
  error: string | null;
  isInitializing: boolean;
  onInitialize: () => void;
};

const ALL_PHASES: OnboardingPhase[] = [
  "checking-account",
  "creating-account",
  "verifying-account",
  "checking-token-accounts",
  "creating-token-accounts",
  "verifying-token-accounts",
];

function phaseIndex(p: OnboardingPhase | null): number {
  if (!p) return -1;
  return ALL_PHASES.indexOf(p);
}

function describeReadiness(r: SwapAccountReadiness | null): ReactNode {
  if (!r) {
    return "Before your first swap, we need to register your account on Arch L2 and create token accounts.";
  }
  const eligible = r.eligibility.eligible;
  const missing = r.missingAtas;

  // Account-level problems take precedence — without an eligible
  // account, the ATA creation tx wouldn't even pay its own fee.
  if (!eligible) {
    switch (r.eligibility.reason) {
      case "missing":
        return missing.length > 0
          ? "Your Arch L2 account hasn't been created yet, and you'll also need token accounts for swaps. We'll handle both in two passkey-signed transactions."
          : "Your Arch L2 account hasn't been created yet. We'll register it with a passkey-signed transaction.";
      case "wrong_owner":
        return "Your Arch L2 account was created with an unexpected owner. Re-initializing will request a fresh account from the validator-blessed system program.";
      case "underfunded":
        return "Your Arch L2 account exists but isn't rent-exempt yet. The faucet will top it up so the validator accepts it as a fee payer.";
    }
  }

  // Account is fine; only ATAs are missing (typical state if you've
  // ever clicked the Dashboard's "Airdrop" button — that creates the
  // account but not the ATAs).
  if (missing.length === 1) {
    return `Your Arch L2 account is registered, but you don't have a ${missing[0]} token account yet. We'll create the missing token accounts in a single passkey-signed transaction.`;
  }
  return `Your Arch L2 account is registered, but you're missing token accounts for ${missing.join(", ")}. We'll create them in a single passkey-signed transaction.`;
}

function passkeyPromptsHint(r: SwapAccountReadiness | null): string {
  if (!r) return "You may be asked to sign with your passkey up to two times.";
  const accountStep = !r.eligibility.eligible;
  const ataStep = r.missingAtas.length > 0;
  const count = (accountStep ? 1 : 0) + (ataStep ? 1 : 0);
  if (count === 0) return "Quick verification — no passkey prompt expected.";
  if (count === 1) return "You'll be asked to sign with your passkey once.";
  return "You'll be asked to sign with your passkey twice (account, then token accounts).";
}

export function OnboardingPanel({
  status,
  readiness,
  phase,
  error,
  isInitializing,
  onInitialize,
}: Props) {
  if (status === "ready" || status === "unknown" || status === "probing") {
    return null;
  }

  const currentIndex = phaseIndex(phase);

  return (
    <div className="onboarding-panel" data-status={status}>
      <div className="onboarding-panel__header">
        <span className="onboarding-panel__pill">One-time setup</span>
        <h3 className="onboarding-panel__title">Initialize for swaps</h3>
      </div>
      <p className="onboarding-panel__copy">
        {describeReadiness(readiness)}
      </p>

      {isInitializing && phase && (
        <div className="onboarding-panel__stepper" aria-live="polite">
          {ALL_PHASES.map((p, idx) => {
            const state =
              idx < currentIndex
                ? "done"
                : idx === currentIndex
                  ? "active"
                  : "pending";
            return (
              <div key={p} className="onboarding-panel__step" data-state={state}>
                <span className="onboarding-panel__bullet" />
                <span className="onboarding-panel__step-label">
                  {labelForPhase(p)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <div className="error-banner onboarding-panel__error">{error}</div>
      )}

      <button
        type="button"
        className="btn btn-primary btn-full"
        disabled={isInitializing}
        onClick={onInitialize}
      >
        {isInitializing
          ? "Setting up your account…"
          : status === "error"
            ? "Try again"
            : "Initialize for swaps"}
      </button>
      <p className="onboarding-panel__fineprint">
        {passkeyPromptsHint(readiness)}
      </p>
    </div>
  );
}
