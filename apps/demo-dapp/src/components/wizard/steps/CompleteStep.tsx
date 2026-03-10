import type { TransactionResult } from "../WizardFlow";

interface CompleteStepProps {
  result: TransactionResult | null;
  onStartNew: () => void;
  network?: string;
}

function getExplorerUrl(txid: string, network?: string): string {
  // Testnet4/Testnet use testnet explorer, Mainnet uses mainnet explorer
  const isMainnet = network?.toLowerCase() === "mainnet";
  if (isMainnet) {
    return `https://explorer.arch.network/tx/${txid}`;
  }
  return `https://explorer.arch.network/testnet/tx/${txid}`;
}

export default function CompleteStep({ result, onStartNew, network }: CompleteStepProps) {
  const isSuccess = result?.success ?? false;
  const explorerTxid = result?.rawTxid || result?.txid;
  const explorerUrl = explorerTxid ? getExplorerUrl(explorerTxid, network) : null;

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

          {/* Explorer Link */}
          {explorerUrl && (
            <div className="complete-detail-row">
              <span className="complete-detail-label">View on Explorer</span>
              <div className="complete-detail-value">
                <a 
                  href={explorerUrl} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="explorer-link"
                >
                  <span>Arch Explorer</span>
                  <span className="external-icon">↗</span>
                </a>
              </div>
            </div>
          )}

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
