/**
 * Validation-aware submit button. Renders a context-appropriate label
 * (Connect / Enter amount / Loading quote / Insufficient balance /
 * Confirm swap / Signing...) so the button itself is the primary
 * error surface.
 */
import type { ReactNode } from "react";

export type SwapValidation =
  | { kind: "no-account" }
  | { kind: "needs-onboarding" }
  | { kind: "empty" }
  | { kind: "exceeds-balance"; available: number; symbol: string }
  | { kind: "quote-loading" }
  | { kind: "quote-failed"; message: string }
  | { kind: "custodial-unsupported" }
  | { kind: "valid" };

type Props = {
  validation: SwapValidation;
  isSubmitting: boolean;
  onSubmit: () => void;
};

function labelFor(validation: SwapValidation, isSubmitting: boolean): ReactNode {
  if (isSubmitting) return "Signing…";
  switch (validation.kind) {
    case "no-account":
      return "Set up a wallet to swap";
    case "needs-onboarding":
      return "Initialize account above to enable swap";
    case "empty":
      return "Enter an amount";
    case "exceeds-balance":
      return `Insufficient ${validation.symbol}`;
    case "quote-loading":
      return "Loading quote…";
    case "quote-failed":
      return "Retry quote";
    case "custodial-unsupported":
      return "Email wallet swaps coming soon";
    case "valid":
      return "Confirm swap";
  }
}

export function SubmitButton({ validation, isSubmitting, onSubmit }: Props) {
  const disabled = isSubmitting || validation.kind !== "valid";
  return (
    <button
      type="button"
      className="btn btn-primary btn-full swap-submit"
      disabled={disabled}
      onClick={onSubmit}
    >
      {labelFor(validation, isSubmitting)}
    </button>
  );
}
