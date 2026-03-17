import { useState, useCallback } from "react";

interface UnlockProps {
  onUnlock: () => void;
}

export default function Unlock({ onUnlock }: UnlockProps) {
  const [loading, setLoading] = useState(false);

  const handleUnlock = useCallback(async () => {
    setLoading(true);
    try {
      await onUnlock();
    } finally {
      setLoading(false);
    }
  }, [onUnlock]);

  return (
    <div className="onboarding">
      <div className="onboarding-logo">🔒</div>
      <h1 className="onboarding-title">Wallet Locked</h1>
      <p className="onboarding-sub">Authenticate to unlock your Arch Wallet.</p>

      <div className="onboarding-actions">
        <button
          className="btn btn-primary btn-full"
          onClick={handleUnlock}
          disabled={loading}
        >
          {loading ? "Unlocking..." : "🔑 Unlock with Passkey"}
        </button>
      </div>
    </div>
  );
}
