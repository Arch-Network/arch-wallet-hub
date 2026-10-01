import { useState, useCallback, useRef, useEffect } from "react";
import RecoverViaEmailCta from "../../components/RecoverViaEmailCta";
import { hasRecoverableAccountHint } from "../../state/wallet-store";

interface UnlockProps {
  /** Called when the user submits a password. Throws on bad password. */
  onUnlock: (password: string) => Promise<void>;
}

export default function Unlock({ onUnlock }: UnlockProps) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // `null` while we're still reading the public hint -- we render the
  // forgot-password footer in a neutral skeleton state during that
  // tiny window so we don't flash the wrong CTA at the user.
  const [canRecoverViaEmail, setCanRecoverViaEmail] = useState<boolean | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    hasRecoverableAccountHint().then((value) => {
      if (!cancelled) setCanRecoverViaEmail(value);
    });
    return () => {
      cancelled = true;
    };
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
        <img src="/arch-mark-orange.svg" alt="Arch" className="brand-swap-light" style={{ width: 64, height: 64 }} />
        <img src="/arch-mark-white.svg" alt="Arch" className="brand-swap-dark" style={{ width: 64, height: 64 }} />
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
        {/* Footer branches on whether this keystore has any Turnkey
            (passkey / email) wallet. Linked external wallets have no
            Hub-side recovery -- the keys live in Xverse / UniSat, not
            in our sub-org -- so showing them "Recover via email" just
            funnels into a dead-end "no candidates for this email"
            screen. The honest path there is a local reset + re-link. */}
        {canRecoverViaEmail === null ? null : canRecoverViaEmail ? (
          <>
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
              Requires the recovery email you set during onboarding. We'll
              send you a one-time code.
            </p>
          </>
        ) : (
          <p
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            Forgot your password? Linked external wallets (Xverse / UniSat)
            can't be recovered from here — your wallet and funds stay safe in
            the external wallet itself. Reset Arch Wallet from{" "}
            <em>chrome://extensions → Remove</em> and re-link from onboarding
            to regain access on this device.
          </p>
        )}
      </div>
    </div>
  );
}
