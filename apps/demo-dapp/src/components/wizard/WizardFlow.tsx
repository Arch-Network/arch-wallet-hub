import { useState, useCallback, useMemo, ReactNode } from "react";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import ConnectStep from "./steps/ConnectStep";
import ActionStep from "./steps/ActionStep";
import DetailsStep from "./steps/DetailsStep";
import ReviewStep from "./steps/ReviewStep";
import CompleteStep from "./steps/CompleteStep";

export type WalletType = "xverse" | "unisat" | "turnkey" | null;
export type ActionType = "arch.transfer" | "arch.anchor";
export type StepId = "connect" | "action" | "details" | "review" | "complete";

export interface WalletState {
  type: WalletType;
  address: string;
  publicKey: string | null;
  network: string;
  turnkeyResourceId?: string;
  // For Turnkey wallets
  isCustodial?: boolean; // true = server can sign, false = passkey must sign
  organizationId?: string;
}

export interface TransactionDetails {
  actionType: ActionType;
  // Transfer fields
  toAddress?: string;
  lamports?: string;
  // Anchor fields
  btcTxid?: string;
  btcVout?: number;
}

export interface TransactionResult {
  success: boolean;
  signingRequestId?: string;
  txid?: string;
  rawTxid?: string;
  error?: string;
}

interface WizardFlowProps {
  client: WalletHubClient;
  externalUserId: string;
  apiKey: string;
  baseUrl: string;
  onApiConfigChange: (baseUrl: string, apiKey: string) => void;
}

const STEPS: { id: StepId; label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "action", label: "Action" },
  { id: "details", label: "Details" },
  { id: "review", label: "Review" },
  { id: "complete", label: "Complete" },
];

export default function WizardFlow({ 
  client, 
  externalUserId, 
  apiKey, 
  baseUrl,
  onApiConfigChange 
}: WizardFlowProps) {
  const [currentStep, setCurrentStep] = useState<StepId>("connect");
  const [direction, setDirection] = useState<"forward" | "backward">("forward");
  
  // Wallet state
  const [wallet, setWallet] = useState<WalletState | null>(null);
  
  // Transaction state
  const [transaction, setTransaction] = useState<TransactionDetails>({
    actionType: "arch.transfer",
    lamports: "1000",
    btcVout: 0,
  });
  
  // Signing request state
  const [signingRequest, setSigningRequest] = useState<any>(null);
  const [result, setResult] = useState<TransactionResult | null>(null);
  
  // Loading states
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentStepIndex = useMemo(
    () => STEPS.findIndex((s) => s.id === currentStep),
    [currentStep]
  );

  const goToStep = useCallback((stepId: StepId) => {
    const newIndex = STEPS.findIndex((s) => s.id === stepId);
    const oldIndex = STEPS.findIndex((s) => s.id === currentStep);
    setDirection(newIndex > oldIndex ? "forward" : "backward");
    setCurrentStep(stepId);
    setError(null);
  }, [currentStep]);

  const goNext = useCallback(() => {
    if (currentStepIndex < STEPS.length - 1) {
      setDirection("forward");
      setCurrentStep(STEPS[currentStepIndex + 1].id);
      setError(null);
    }
  }, [currentStepIndex]);

  const goBack = useCallback(() => {
    if (currentStepIndex > 0) {
      setDirection("backward");
      setCurrentStep(STEPS[currentStepIndex - 1].id);
      setError(null);
    }
  }, [currentStepIndex]);

  const resetWizard = useCallback(() => {
    setCurrentStep("connect");
    setWallet(null);
    setTransaction({ actionType: "arch.transfer", lamports: "1000", btcVout: 0 });
    setSigningRequest(null);
    setResult(null);
    setError(null);
    setDirection("forward");
  }, []);

  const handleWalletConnected = useCallback((newWallet: WalletState) => {
    setWallet(newWallet);
    goNext();
  }, [goNext]);

  const handleActionSelected = useCallback((actionType: ActionType) => {
    setTransaction((prev) => ({ ...prev, actionType }));
    goNext();
  }, [goNext]);

  const handleDetailsSubmit = useCallback((details: Partial<TransactionDetails>) => {
    setTransaction((prev) => ({ ...prev, ...details }));
    goNext();
  }, [goNext]);

  const handleSigningRequestCreated = useCallback((sr: any) => {
    setSigningRequest(sr);
  }, []);

  const handleTransactionComplete = useCallback((txResult: TransactionResult) => {
    setResult(txResult);
    goToStep("complete");
  }, [goToStep]);

  // Render step indicator
  const renderStepIndicator = () => (
    <div className="wizard-steps">
      {STEPS.map((step, index) => {
        const isActive = step.id === currentStep;
        const isCompleted = index < currentStepIndex;
        const isClickable = isCompleted;
        
        return (
          <div key={step.id} className="wizard-step-wrapper">
            <button
              className={`wizard-step ${isActive ? "active" : ""} ${isCompleted ? "completed" : ""}`}
              onClick={() => isClickable && goToStep(step.id)}
              disabled={!isClickable}
              type="button"
            >
              <span className="wizard-step-number">
                {isCompleted ? "✓" : index + 1}
              </span>
              <span className="wizard-step-label">{step.label}</span>
            </button>
            {index < STEPS.length - 1 && (
              <div className={`wizard-step-connector ${isCompleted ? "completed" : ""}`} />
            )}
          </div>
        );
      })}
    </div>
  );

  // Render current step content
  const renderStepContent = (): ReactNode => {
    const commonProps = {
      isLoading,
      setIsLoading,
      error,
      setError,
    };

    switch (currentStep) {
      case "connect":
        return (
          <ConnectStep
            {...commonProps}
            wallet={wallet}
            onWalletConnected={handleWalletConnected}
            apiKey={apiKey}
            baseUrl={baseUrl}
            onApiConfigChange={onApiConfigChange}
            externalUserId={externalUserId}
            client={client}
          />
        );
      case "action":
        return (
          <ActionStep
            {...commonProps}
            selectedAction={transaction.actionType}
            onActionSelected={handleActionSelected}
            onBack={goBack}
          />
        );
      case "details":
        return (
          <DetailsStep
            {...commonProps}
            actionType={transaction.actionType}
            transaction={transaction}
            onSubmit={handleDetailsSubmit}
            onBack={goBack}
          />
        );
      case "review":
        return (
          <ReviewStep
            {...commonProps}
            client={client}
            externalUserId={externalUserId}
            wallet={wallet!}
            transaction={transaction}
            signingRequest={signingRequest}
            onSigningRequestCreated={handleSigningRequestCreated}
            onComplete={handleTransactionComplete}
            onBack={goBack}
          />
        );
      case "complete":
        return (
          <CompleteStep
            result={result}
            onStartNew={resetWizard}
            network={wallet?.network}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="wizard-container">
      {/* Header with step indicator */}
      <div className="wizard-header">
        <div className="wizard-logo">
          <div className="wizard-logo-icon">⚡</div>
          <div className="wizard-logo-text">
            <span className="wizard-logo-title">Arch Wallet Hub</span>
            <span className="wizard-logo-subtitle">Demo</span>
          </div>
        </div>
        {renderStepIndicator()}
      </div>

      {/* Step content */}
      <div className="wizard-content">
        <div className={`wizard-step-content ${direction}`} key={currentStep}>
          {renderStepContent()}
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="wizard-error">
          <span className="wizard-error-icon">⚠️</span>
          <span>{error}</span>
          <button onClick={() => setError(null)} className="wizard-error-dismiss">✕</button>
        </div>
      )}
    </div>
  );
}
