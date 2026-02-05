import type { TransactionResult } from "../WizardFlow";

interface CompleteStepProps {
  result: TransactionResult | null;
  onStartNew: () => void;
}

export default function CompleteStep({ result, onStartNew }: CompleteStepProps) {
  const isSuccess = result?.success ?? false;

  return (
    <div className="step-container complete-step">
      <div className="complete-icon-wrapper">
        <div className={`complete-icon ${isSuccess ? "success" : "error"}`}>
          {isSuccess ? "✓" : "✕"}
        </div>
      </div>

      <div className="step-header centered">
        <h1 className="step-title">
          {isSuccess ? "Transaction Submitted!" : "Transaction Failed"}
        </h1>
        <p className="step-description">
          {isSuccess
            ? "Your transaction has been broadcast to the Arch Network."
            : result?.error || "Something went wrong. Please try again."}
        </p>
      </div>

      {/* Transaction Details */}
      {isSuccess && result?.txid && (
        <div className="complete-details">
          <div className="complete-detail-row">
            <span className="complete-detail-label">Transaction ID</span>
            <div className="complete-detail-value">
              <code className="mono">{result.txid}</code>
              <button
                className="copy-btn"
                onClick={() => navigator.clipboard.writeText(result.txid!)}
                title="Copy to clipboard"
                type="button"
              >
                📋
              </button>
            </div>
          </div>

          {result.signingRequestId && (
            <div className="complete-detail-row">
              <span className="complete-detail-label">Request ID</span>
              <div className="complete-detail-value">
                <code className="mono" style={{ fontSize: 11 }}>
                  {result.signingRequestId}
                </code>
                <button
                  className="copy-btn"
                  onClick={() => navigator.clipboard.writeText(result.signingRequestId!)}
                  title="Copy to clipboard"
                  type="button"
                >
                  📋
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error Details */}
      {!isSuccess && result?.error && (
        <div className="complete-error">
          <details>
            <summary>Error Details</summary>
            <pre className="mono">{result.error}</pre>
          </details>
        </div>
      )}

      {/* Action Buttons */}
      <div className="step-actions centered">
        <button className="btn-primary" onClick={onStartNew} type="button">
          {isSuccess ? "Start New Transaction" : "Try Again"}
        </button>
      </div>

      {/* Success Animation */}
      {isSuccess && (
        <div className="confetti-wrapper" aria-hidden="true">
          <div className="confetti"></div>
          <div className="confetti"></div>
          <div className="confetti"></div>
          <div className="confetti"></div>
          <div className="confetti"></div>
        </div>
      )}
    </div>
  );
}
