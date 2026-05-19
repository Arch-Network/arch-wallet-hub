/**
 * Dashboard-level affordance pointing the user at the one-time
 * "Initialize for swaps" flow.
 *
 * Two design decisions:
 *
 *   1. The banner can run onboarding inline (no navigation) so users
 *      finish the setup without bouncing through the Swap page. The
 *      `useArchOnboarding` hook is shared module state from the caller,
 *      so the Swap page will see the resulting `ready` status the
 *      moment they navigate to it.
 *
 *   2. We deliberately keep the visual weight low (a slim card, not a
 *      full-bleed banner). The Dashboard is already busy; the goal is
 *      to advertise the capability, not interrupt the user.
 *
 * Hidden entirely when the account is already eligible or while the
 * probe is in flight to avoid layout shift on every navigation.
 */
import type { OnboardingPhase } from "@arch/swap-engine";

import { labelForPhase } from "../hooks/useArchOnboarding";

type Props = {
  status: "unknown" | "probing" | "ready" | "needs-onboarding" | "error";
  phase: OnboardingPhase | null;
  error: string | null;
  isInitializing: boolean;
  onInitialize: () => void;
};

export function SwapOnboardingBanner({
  status,
  phase,
  error,
  isInitializing,
  onInitialize,
}: Props) {
  if (status === "unknown" || status === "probing" || status === "ready") {
    return null;
  }
  return (
    <div className="swap-onboarding-banner" data-status={status}>
      <div className="swap-onboarding-banner__icon" aria-hidden="true">
        {/* Spark icon — signals "do this once and you're set". */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      </div>
      <div className="swap-onboarding-banner__body">
        <div className="swap-onboarding-banner__title">
          {isInitializing
            ? "Setting up your Arch account…"
            : "Enable swaps on this wallet"}
        </div>
        <div className="swap-onboarding-banner__copy">
          {isInitializing && phase
            ? labelForPhase(phase)
            : error
              ? error
              : "Your account isn't registered on Arch L2 yet. Initialize it once to unlock in-wallet swaps."}
        </div>
      </div>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={isInitializing}
        onClick={onInitialize}
      >
        {isInitializing
          ? "Working…"
          : status === "error"
            ? "Try again"
            : "Initialize"}
      </button>
    </div>
  );
}
