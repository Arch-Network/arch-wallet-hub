import type { ActionType } from "../WizardFlow";

interface ActionStepProps {
  selectedAction: ActionType;
  onActionSelected: (action: ActionType) => void;
  onBack: () => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
}

const ACTIONS: { type: ActionType; icon: string; title: string; description: string }[] = [
  {
    type: "arch.transfer",
    icon: "↗",
    title: "Transfer",
    description: "Send ARCH tokens to another account on the Arch Network",
  },
  {
    type: "arch.anchor",
    icon: "⚓",
    title: "Anchor UTXO",
    description: "Link a Bitcoin UTXO to your Arch account for transaction signing",
  },
];

export default function ActionStep({
  selectedAction,
  onActionSelected,
  onBack,
}: ActionStepProps) {
  return (
    <div className="step-container">
      <div className="step-header">
        <h1 className="step-title">Select Action</h1>
        <p className="step-description">
          What would you like to do on Arch Network?
        </p>
      </div>

      <div className="step-section">
        <div className="action-grid">
          {ACTIONS.map((action) => (
            <button
              key={action.type}
              className={`action-card ${selectedAction === action.type ? "selected" : ""}`}
              onClick={() => onActionSelected(action.type)}
              type="button"
            >
              <div className="action-card-icon">{action.icon}</div>
              <div className="action-card-content">
                <h3 className="action-card-title">{action.title}</h3>
                <p className="action-card-description">{action.description}</p>
              </div>
              <div className="action-card-check">
                {selectedAction === action.type ? "●" : "○"}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Back button */}
      <div className="step-actions">
        <button className="btn-secondary" onClick={onBack} type="button">
          ← Back
        </button>
      </div>
    </div>
  );
}
