import { useState, useCallback, useRef, useEffect } from "react";
import RecoverViaEmailCta from "../../components/RecoverViaEmailCta";

interface UnlockProps {
  /** Called when the user submits a password. Throws on bad password. */
  onUnlock: (password: string) => Promise<void>;
}

export default function Unlock({ onUnlock }: UnlockProps) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!password) return;
      setLoading(true);
      setError(null);
      try {
        await onUnlock(password);
      } catch (err: any) {
        const msg = err?.name === "WrongPasswordError" ? "Incorrect password" : err?.message || "Failed to unlock";
        setError(msg);
        setPassword("");
        setTimeout(() => inputRef.current?.focus(), 0);
      } finally {
        setLoading(false);
      }
    },
    [password, onUnlock],
  );

  return (
    <div className="onboarding">
      <div className="onboarding-logo">
        <img src="/arch-logo.svg" alt="Arch" style={{ width: 64, height: 64 }} />
      </div>
      <h1 className="onboarding-title">Welcome back</h1>
      <p className="onboarding-sub">Enter your password to unlock the wallet.</p>

      {error && <div className="error-banner">{error}</div>}

      <form onSubmit={handleSubmit} style={{ width: "100%" }}>
        <div style={{ marginBottom: 12, textAlign: "left" }}>
          <label className="input-label" style={{ display: "block", marginBottom: 4 }}>
            Password
          </label>
          <input
            ref={inputRef}
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
            autoComplete="current-password"
            disabled={loading}
            style={{ width: "100%", boxSizing: "border-box" }}
          />
        </div>

        <div className="onboarding-actions">
          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={loading || !password}
          >
            {loading ? "Unlocking..." : "Unlock"}
          </button>
        </div>
      </form>

      <div
        style={{
          marginTop: 20,
          paddingTop: 16,
          borderTop: "1px solid var(--border-primary)",
          width: "100%",
          textAlign: "center",
        }}
      >
        <p
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            margin: 0,
            marginBottom: 8,
          }}
        >
          Forgot your password?
        </p>
        {/* Cold entry -- we don't know which wallet the user is
            trying to recover yet, so no externalUserId pin. The
            Recover screen will pick by email. */}
        <RecoverViaEmailCta
          pinToActiveAccount={false}
          title="Forgot your password? Recover with the email you set during onboarding."
        />
        <p
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            marginTop: 8,
            marginBottom: 0,
            lineHeight: 1.5,
          }}
        >
          Requires the recovery email you set during onboarding. We'll send
          you a one-time code.
        </p>
      </div>
    </div>
  );
}
