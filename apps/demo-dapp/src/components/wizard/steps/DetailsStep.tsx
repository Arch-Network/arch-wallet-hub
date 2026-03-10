import { useState, useEffect } from "react";
import type { ActionType, TransactionDetails } from "../WizardFlow";

interface DetailsStepProps {
  actionType: ActionType;
  transaction: TransactionDetails;
  onSubmit: (details: Partial<TransactionDetails>) => void;
  onBack: () => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
}

export default function DetailsStep({
  actionType,
  transaction,
  onSubmit,
  onBack,
  setError,
}: DetailsStepProps) {
  // Transfer fields
  const [toAddress, setToAddress] = useState(transaction.toAddress || "");
  const [amountUnit, setAmountUnit] = useState<"lamports" | "arch">("lamports");
  const [lamports, setLamports] = useState(transaction.lamports || "1000");
  const [archInputValue, setArchInputValue] = useState("");

  // Anchor fields
  const [btcTxid, setBtcTxid] = useState(transaction.btcTxid || "");
  const [btcVout, setBtcVout] = useState(transaction.btcVout ?? 0);

  // Validation
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Sync ARCH input value
  useEffect(() => {
    if (amountUnit === "arch" && !archInputValue) {
      setArchInputValue((parseInt(lamports) / 1000000000).toString());
    }
  }, [amountUnit, lamports, archInputValue]);

  const handleArchInputChange = (value: string) => {
    // Allow only valid decimal input
    if (!/^[0-9]*\.?[0-9]*$/.test(value)) return;
    setArchInputValue(value);
    
    // Convert to lamports
    const archNum = parseFloat(value) || 0;
    const newLamports = Math.floor(archNum * 1000000000);
    setLamports(newLamports.toString());
  };

  const handleLamportsChange = (value: string) => {
    // Allow only integers
    if (!/^[0-9]*$/.test(value)) return;
    setLamports(value);
    setArchInputValue(""); // Clear ARCH input when editing lamports
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (actionType === "arch.transfer") {
      if (!toAddress.trim()) {
        newErrors.toAddress = "Recipient address is required";
      }
      const lamportsNum = parseInt(lamports);
      if (isNaN(lamportsNum) || lamportsNum <= 0) {
        newErrors.amount = "Amount must be greater than 0";
      }
    } else if (actionType === "arch.anchor") {
      if (!btcTxid.trim()) {
        newErrors.btcTxid = "UTXO Transaction ID is required";
      } else if (!/^[a-fA-F0-9]{64}$/.test(btcTxid.trim())) {
        newErrors.btcTxid = "Transaction ID must be 64 hex characters";
      }
      if (btcVout < 0) {
        newErrors.btcVout = "Output index must be 0 or greater";
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    setError(null);
    if (!validate()) return;

    if (actionType === "arch.transfer") {
      onSubmit({ toAddress: toAddress.trim(), lamports });
    } else {
      onSubmit({ btcTxid: btcTxid.trim(), btcVout });
    }
  };

  const lamportsNum = parseInt(lamports) || 0;
  const archEquivalent = (lamportsNum / 1000000000).toFixed(9);

  return (
    <div className="step-container">
      <div className="step-header">
        <h1 className="step-title">
          {actionType === "arch.transfer" ? "Transfer Details" : "Anchor Details"}
        </h1>
        <p className="step-description">
          {actionType === "arch.transfer"
            ? "Enter the recipient address and amount to send"
            : "Enter the Bitcoin UTXO to anchor to your account"}
        </p>
      </div>

      <div className="step-section">
        {actionType === "arch.transfer" ? (
          <>
            {/* Recipient Address */}
            <div className="form-group">
              <label className="form-label">Recipient Address</label>
              <input
                type="text"
                className={`form-input mono ${errors.toAddress ? "error" : ""}`}
                value={toAddress}
                onChange={(e) => setToAddress(e.target.value)}
                placeholder="Enter Arch account address"
              />
              {errors.toAddress && (
                <span className="form-error">{errors.toAddress}</span>
              )}
            </div>

            {/* Amount */}
            <div className="form-group">
              <label className="form-label">Amount</label>
              <div className="amount-input-wrapper">
                <input
                  type="text"
                  className={`form-input amount-input ${errors.amount ? "error" : ""}`}
                  value={amountUnit === "arch" ? archInputValue : lamports}
                  onChange={(e) =>
                    amountUnit === "arch"
                      ? handleArchInputChange(e.target.value)
                      : handleLamportsChange(e.target.value)
                  }
                  placeholder={amountUnit === "arch" ? "0.00000000" : "0"}
                />
                <select
                  className="amount-unit-select"
                  value={amountUnit}
                  onChange={(e) => setAmountUnit(e.target.value as "lamports" | "arch")}
                >
                  <option value="lamports">lamports</option>
                  <option value="arch">ARCH</option>
                </select>
              </div>
              {errors.amount && (
                <span className="form-error">{errors.amount}</span>
              )}
              <div className="form-hint">
                {amountUnit === "lamports"
                  ? `≈ ${archEquivalent} ARCH`
                  : `= ${lamportsNum.toLocaleString()} lamports`}
              </div>
            </div>
          </>
        ) : (
          <>
            {/* UTXO Transaction ID */}
            <div className="form-group">
              <label className="form-label">UTXO Transaction ID</label>
              <input
                type="text"
                className={`form-input mono ${errors.btcTxid ? "error" : ""}`}
                value={btcTxid}
                onChange={(e) => setBtcTxid(e.target.value)}
                placeholder="64-character hex transaction ID"
              />
              {errors.btcTxid && (
                <span className="form-error">{errors.btcTxid}</span>
              )}
            </div>

            {/* Output Index */}
            <div className="form-group">
              <label className="form-label">Output Index (vout)</label>
              <input
                type="number"
                className={`form-input ${errors.btcVout ? "error" : ""}`}
                value={btcVout}
                onChange={(e) => setBtcVout(parseInt(e.target.value) || 0)}
                min={0}
                placeholder="0"
              />
              {errors.btcVout && (
                <span className="form-error">{errors.btcVout}</span>
              )}
              <div className="form-hint">
                Usually 0 for the first output, 1 for the second, etc.
              </div>
            </div>
          </>
        )}
      </div>

      {/* Actions */}
      <div className="step-actions">
        <button className="btn-secondary" onClick={onBack} type="button">
          ← Back
        </button>
        <button className="btn-primary" onClick={handleSubmit} type="button">
          Continue →
        </button>
      </div>
    </div>
  );
}
