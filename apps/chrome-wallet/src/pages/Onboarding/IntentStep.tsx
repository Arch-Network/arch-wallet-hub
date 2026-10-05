import type { ReactNode } from "react";

export type CreateMethod = "passkey" | "email";

const ICON_PROPS = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function ChoiceCard({
  icon,
  title,
  badge,
  sub,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  badge?: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="onboarding-choice-card" onClick={onClick}>
      <span className="onboarding-choice-card-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="onboarding-choice-card-body">
        <p className="onboarding-choice-card-title">
          {title}
          {badge && <span className="onboarding-choice-card-badge">{badge}</span>}
        </p>
        <p className="onboarding-choice-card-sub">{sub}</p>
      </div>
    </button>
  );
}

interface IntentStepProps {
  onCreate: () => void;
  onConnect: () => void;
  /** Routes to /recover, which adds this device to an existing wallet. */
  onRestore: () => void;
}

/** First question: what the user is here to do, before how they sign. */
export function IntentStep({ onCreate, onConnect, onRestore }: IntentStepProps) {
  return (
    <div className="onboarding-choice">
      <ChoiceCard
        icon={
          <svg {...ICON_PROPS}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v8" />
            <path d="M8 12h8" />
          </svg>
        }
        title="Create a new wallet"
        sub="A new Bitcoin and Arch wallet that you approve with a passkey or an email code."
        onClick={onCreate}
      />
      <ChoiceCard
        icon={
          <svg {...ICON_PROPS}>
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 9h10" />
            <path d="M7 13h6" />
            <path d="M17 16l2 2 3-4" />
          </svg>
        }
        title="Connect Xverse or UniSat"
        sub="Use the wallet you already have. You approve in that wallet; no seed phrase is needed."
        onClick={onConnect}
      />
      <ChoiceCard
        icon={
          <svg {...ICON_PROPS}>
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <path d="M10 17l5-5-5-5" />
            <path d="M15 12H3" />
          </svg>
        }
        title="Restore an Arch wallet"
        sub="Already use Arch on another device? Verify your recovery email to add this one."
        onClick={onRestore}
      />
    </div>
  );
}

interface CreateMethodStepProps {
  onPick: (method: CreateMethod) => void;
  onBack: () => void;
}

/** Inside Create: how transactions are approved. Unlock is a local password either way. */
export function CreateMethodStep({ onPick, onBack }: CreateMethodStepProps) {
  return (
    <>
      <div className="onboarding-choice">
        <ChoiceCard
          icon={
            <svg {...ICON_PROPS}>
              <path d="M12 11v4a3 3 0 0 0 3 3" />
              <path d="M8 8a4 4 0 0 1 8 0v5" />
              <path d="M4 12a8 8 0 0 1 16 0v3" />
              <path d="M9 21a8 8 0 0 0 3-6" />
            </svg>
          }
          title="Passkey"
          badge="Recommended"
          sub="Approve with Face ID, Touch ID, or a password manager. Recover with your email if you lose it."
          onClick={() => onPick("passkey")}
        />
        <ChoiceCard
          icon={
            <svg {...ICON_PROPS}>
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="m3 7 9 6 9-6" />
            </svg>
          }
          title="Email"
          sub="Approve with a code sent to your email. For devices without passkey support."
          onClick={() => onPick("email")}
        />
      </div>
      <button type="button" className="link-btn onboarding-intent-back" onClick={onBack}>
        Back
      </button>
    </>
  );
}
