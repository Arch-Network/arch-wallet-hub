/**
 * SessionBootstrapper -- email-wallet OTP gate.
 *
 * Lifecycle:
 *   - Mounted whenever the active account is `authMethod === "email"`
 *     AND no Turnkey session is currently open (sessionManager
 *     returns null).
 *   - Step 1: auto-send an OTP to the account's recoveryEmail. The
 *     user sees a "we sent a code to you@example.com" banner.
 *   - Step 2: user types the 6-digit code. On submit we generate an
 *     ephemeral P-256 keypair, ask the Hub to verify the OTP, and
 *     hand the resulting credentialBundle + ephemeral private key to
 *     `walletStore.openEmailSession(...)`, which internally runs the
 *     bootstrap-email flow (HPKE-decrypt -> STAMP_LOGIN -> drop
 *     recovery key).
 *
 * Why this lives in `src/session/` and not in a top-level page:
 *   - It's a *gate*, not a route. The same bootstrapper has to run
 *     after onboarding (fresh email wallet), after unlock (existing
 *     email wallet, prior session expired), and any time auto-lock
 *     trips while an email wallet is active. Co-locating it with
 *     the SessionManager keeps the "session lifecycle" code in one
 *     place.
 *
 * Failure modes:
 *   - Wrong OTP: surfaced inline; the Hub increments attempts and
 *     eventually 429s, at which point the user can re-init.
 *   - Network blip mid-bootstrap: we keep state local; user
 *     re-enters the code. The Hub's 3-attempt cap protects against
 *     guessing.
 *   - User backs out: caller can dismiss by calling onCancel
 *     (currently just locks the wallet on dismissal so we never
 *     leave the popup in a half-authenticated state).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { WalletHubClient } from "@arch-network/wallet-hub-sdk";
import type { RecoveryEmailCandidate } from "@arch-network/wallet-hub-sdk";
import { useNavigate } from "react-router-dom";
import { walletStore } from "../state/wallet-store";
import { generateRecoveryKeypair } from "../crypto/turnkey-bundle";
import type { WalletAccount } from "../state/types";
import { log } from "../utils/log";

interface Props {
  account: WalletAccount;
  /**
   * Other accounts on this install. Surfaces a "Switch wallet"
   * affordance from the error state when the user is stuck on a
   * particular wallet but has working alternatives.
   */
  otherAccounts?: WalletAccount[];
  /** Fires after the session is open and the wallet can sign again. */
  onReady: () => void;
  /** Fires if the user backs out; caller is expected to lock again. */
  onCancel: () => void;
  /**
   * Called when the user forgets *this* account (removes it locally).
   * Caller is expected to refresh state -- after the forget completes,
   * either there's a new active account or the wallet is empty and
   * the caller should send the user to onboarding.
   */
  onAccountForgotten?: () => void | Promise<void>;
  /** Called when the user picks a different account from the picker. */
  onSwitchAccount?: (accountId: string) => void;
}

type Stage = "init" | "otp" | "verifying" | "ready" | "error";

function candidateMatchesAccount(
  candidate: RecoveryEmailCandidate,
  account: WalletAccount,
): boolean {
  if (candidate.resourceId && candidate.resourceId === account.turnkeyResourceId) {
    return true;
  }
  if (candidate.defaultAddress && candidate.defaultAddress === account.btcAddress) {
    return true;
  }
  return false;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  code: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(code)), ms);
    }),
  ]);
}

export default function SessionBootstrapper({
  account,
  otherAccounts = [],
  onReady,
  onCancel,
  onAccountForgotten,
  onSwitchAccount,
}: Props) {
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>("init");
  const [error, setError] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [candidateToken, setCandidateToken] = useState<string | null>(null);
  const [emailMasked, setEmailMasked] = useState<string>("");
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  const forgetCurrentAccount = useCallback(async () => {
    if (forgetting) return;
    setForgetting(true);
    setError(null);
    try {
      await walletStore.forgetAccount(account.id);
      await onAccountForgotten?.();
      navigate("/", { replace: true });
      // This component is itself the stale gate we're escaping from.
      // Force a view reload after the durable local state update so
      // React cannot keep rendering the old active account prop while
      // storage listeners catch up.
      setTimeout(() => globalThis.location.reload(), 0);
    } catch (e: any) {
      setError(e?.message || "Failed to forget wallet");
      setForgetting(false);
    }
  }, [account.id, forgetting, navigate, onAccountForgotten]);

  const recoveryEmail = useMemo(
    () => account.recoveryEmail?.trim() ?? "",
    [account.recoveryEmail],
  );

  // `noEmailOnFile` is a terminal state -- "Retry" would just hit
  // the same guard. We surface specific recovery paths instead.
  const noEmailOnFile = !recoveryEmail;

  const buildClient = useCallback(async () => {
    const state = await walletStore.getState().catch(() => null);
    return new WalletHubClient({
      baseUrl: state?.hubBaseUrl ?? "",
      ...(state?.hubApiKey ? { apiKey: state.hubApiKey } : {}),
    });
  }, []);

  // Auto-fire init on mount. The Hub's rate limiter prevents a
  // mounting storm from spamming OTPs; we also guard with stage.
  //
  // Timeout posture: if the Hub never responds (DNS blackhole, ALB
  // 504, etc.) the spinner would otherwise show forever. We race
  // the request against a hard 20s deadline and surface a
  // human-readable error so the user can hit Retry or Forget
  // instead of staring at a stuck spinner.
  useEffect(() => {
    if (stage !== "init") return;
    if (!recoveryEmail) {
      setError(
        "This wallet has no recovery email on file. Re-create it or recover via Settings.",
      );
      setStage("error");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const client = await buildClient();
        const timeoutMs = 20_000;
        const res = await Promise.race([
          client.initRecoveryEmail({ email: recoveryEmail }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("init-timeout")),
              timeoutMs,
            ),
          ),
        ]);
        if (cancelled) return;
        if (res.candidates.length === 0) {
          // The Hub returns empty candidates for three reasons:
          //   1) Email genuinely matches no user (anti-enumeration)
          //   2) Per-email rate limit hit (also anti-enumeration --
          //      same shape as case 1)
          //   3) User exists but has no eligible sub-org wallets
          // We can't tell the cases apart from the response so we
          // cover the realistic remediation paths in one message.
          throw new Error(
            "We couldn't find an active code for that email. " +
              "If you've tried a few times in the last hour, wait a bit and retry. " +
              "Otherwise lock the wallet and use Recover via email from there.",
          );
        }
        // Unlocking is account-specific. The same email may back multiple
        // wallets, so choose the candidate tied to this local account instead
        // of spending the OTP against whichever wallet the Hub returned first.
        const candidate =
          res.candidates.find((c) => candidateMatchesAccount(c, account)) ??
          (res.candidates.length === 1 ? res.candidates[0] : null);
        if (!candidate) {
          throw new Error(
            "We found wallet(s) for this email, but none match the active wallet. " +
              "Lock and use Recover via email if you want to restore one of them.",
          );
        }
        const started = await client.startRecoveryEmailOtp({
          challengeId: res.challengeId,
          candidateToken: candidate.candidateToken,
          email: recoveryEmail,
        });
        setChallengeId(res.challengeId);
        setCandidateToken(candidate.candidateToken);
        setEmailMasked(started.emailMasked || res.emailMasked);
        setStage("otp");
      } catch (e: any) {
        if (cancelled) return;
        const isTimeout = e?.message === "init-timeout";
        setError(
          isTimeout
            ? "Couldn't reach the recovery server. Check your connection and retry, or forget this wallet to start over."
            : e?.message || "Failed to send verification code",
        );
        setStage("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stage, recoveryEmail, buildClient]);

  const verify = useCallback(async () => {
    if (!challengeId || !candidateToken) return;
    setStage("verifying");
    setError(null);
    try {
      const client = await buildClient();
      log.info("email-session.verify.start", {
        accountId: account.id,
        challengeId,
      });
      const keypair = await withTimeout(
        generateRecoveryKeypair(),
        10_000,
        "keygen-timeout",
      );

      // Phase 1: spend the OTP at the Hub. A stuck Hub/Turnkey
      // upstream must not trap the user on "Verifying..." forever.
      const verifyRes = await withTimeout(
        client.verifyRecoveryEmail({
          challengeId,
          candidateToken,
          code: otp.trim(),
          ephemeralPublicKey: keypair.publicKeyUncompressedHex,
        }),
        30_000,
        "verify-timeout",
      );
      log.info("email-session.verify.complete", {
        accountId: account.id,
        organizationMatches: verifyRes.organizationId === account.organizationId,
      });
      // Guard against the (rare) case where multiple sub-orgs share
      // the email and the Hub picked one that isn't the wallet we're
      // unlocking. STAMP_LOGIN would silently fail otherwise.
      if (verifyRes.organizationId !== account.organizationId) {
        throw new Error(
          "Verification returned a different wallet than the one " +
            "currently active. Please lock and use Recover via email.",
        );
      }
      // Phase 2: decrypt the credential bundle locally and run
      // Turnkey STAMP_LOGIN to register the IndexedDB session key.
      // This is where a hung Turnkey browser SDK call would otherwise
      // leave the button on "Verifying..." with no visible network
      // request to the Hub.
      log.info("email-session.bootstrap.start", { accountId: account.id });
      await withTimeout(
        walletStore.openEmailSession({
          credentialBundle: verifyRes.credentialBundle,
          ephemeralPrivateKeyHex: keypair.privateKeyHex,
        }),
        30_000,
        "bootstrap-timeout",
      );
      log.info("email-session.bootstrap.complete", { accountId: account.id });
      setStage("ready");
      onReady();
    } catch (e: any) {
      log.warn("email-session.unlock.failed", {
        accountId: account.id,
        message: e?.message,
      });
      const isKeygenTimeout = e?.message === "keygen-timeout";
      const isVerifyTimeout = e?.message === "verify-timeout";
      const isBootstrapTimeout = e?.message === "bootstrap-timeout";
      setError(
        isKeygenTimeout
          ? "Creating the local recovery key took too long. Lock the wallet and try again."
          : isVerifyTimeout
          ? "The verification request didn't come back in time. Try again, or cancel to lock the wallet."
          : isBootstrapTimeout
            ? "The code was accepted, but opening the local signing session timed out. Lock the wallet and try again."
          : e?.message || "Invalid or expired code",
      );
      setStage(isBootstrapTimeout ? "error" : "otp");
    }
  }, [challengeId, candidateToken, otp, account.organizationId, buildClient, onReady]);

  // Subheader is context-sensitive: showing "we just sent a code
  // to ." is worse than showing nothing, and outright wrong when
  // the account has no email on file.
  const subheader = noEmailOnFile
    ? "This wallet needs an email-based recovery to sign. Use the recovery flow below to attach one."
    : stage === "otp" || stage === "verifying"
      ? `Email wallets re-verify on every unlock. We just sent a 6-digit code to ${emailMasked || recoveryEmail}.`
      : "Email wallets re-verify on every unlock.";

  return (
    <div className="onboarding">
      <div className="onboarding-logo">
        <img src="/arch-logo.svg" alt="Arch" style={{ width: 64, height: 64 }} />
      </div>
      <h1 className="onboarding-title">Verify by email</h1>
      <p className="onboarding-sub">{subheader}</p>

      {error && <div className="error-banner">{error}</div>}

      {stage === "init" && (
        <div style={{ marginTop: 12, width: "100%" }}>
          <div
            className="spinner"
            style={{ width: 32, height: 32, margin: "0 auto 16px" }}
          />
          {/* Even on the happy path the init call can take a few
              seconds (Hub OTP mint + email send). We surface a
              passive caption so the user isn't worried, plus an
              always-available "lock" escape so they're never stuck
              if the spinner stalls. */}
          <p
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              textAlign: "center",
              margin: "0 0 12px",
            }}
          >
            Sending code...
          </p>
          <button
            className="btn btn-link"
            type="button"
            onClick={onCancel}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
              textDecoration: "underline",
              width: "100%",
            }}
          >
            Cancel and lock wallet
          </button>
          <button
            className="btn btn-link"
            type="button"
            onClick={() => {
              setError(null);
              setConfirmingForget(true);
              setStage("error");
            }}
            style={{
              marginTop: 10,
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
              textDecoration: "underline",
              width: "100%",
            }}
          >
            Forget this wallet on this device
          </button>
        </div>
      )}

      {(stage === "otp" || stage === "verifying") && (
        <>
          <div style={{ marginBottom: 12, textAlign: "left", width: "100%" }}>
            <label className="input-label">One-time code</label>
            <input
              className="input"
              type="text"
              inputMode="numeric"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              maxLength={9}
              style={{ width: "100%", boxSizing: "border-box" }}
              autoComplete="one-time-code"
              autoFocus
            />
          </div>
          <button
            className="btn btn-primary btn-full"
            onClick={verify}
            disabled={stage === "verifying" || !otp}
          >
            {stage === "verifying" ? "Verifying..." : "Unlock signing"}
          </button>
          <button
            className="btn btn-link"
            type="button"
            onClick={onCancel}
            style={{
              marginTop: 8,
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
              textDecoration: "underline",
            }}
          >
            Cancel and lock wallet
          </button>
        </>
      )}

      {stage === "error" && (
        <div style={{ width: "100%" }}>
          {/* Retry is hidden in the no-email case -- it would just
              hit the same precondition check and surface the same
              error. The recovery flow is the only real fix there. */}
          {!noEmailOnFile && (
            <button
              className="btn btn-secondary btn-full"
              onClick={() => {
                setError(null);
                setStage("init");
              }}
              style={{ marginBottom: 8 }}
            >
              Retry
            </button>
          )}
          <button
            className="btn btn-primary btn-full"
            onClick={() => navigate("/recover")}
            style={{ marginBottom: 8 }}
          >
            Recover via email
          </button>

          {/* Switch-wallet only renders when there's at least one
              healthy peer to switch to. The picker stays compact --
              one row per peer, no labels beyond what the user picked
              at creation. */}
          {otherAccounts.length > 0 && onSwitchAccount && (
            <div
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTop: "1px solid var(--border-primary)",
              }}
            >
              <p
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  margin: "0 0 6px",
                  textAlign: "left",
                }}
              >
                Or switch to another wallet on this device:
              </p>
              {otherAccounts.map((acct) => (
                <button
                  key={acct.id}
                  type="button"
                  className="btn btn-secondary btn-full"
                  onClick={() => onSwitchAccount(acct.id)}
                  style={{ marginBottom: 4, textAlign: "left" }}
                  title={`Use "${acct.label}" instead`}
                >
                  {acct.label}{" "}
                  <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
                    ({acct.authMethod})
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Destructive escape hatch -- local-only forget. We gate
              behind a confirm step because the user has no easy way
              to "un-forget"; if they actually need this wallet they
              must come back via Recover. */}
          <div
            style={{
              marginTop: 16,
              paddingTop: 12,
              borderTop: "1px solid var(--border-primary)",
            }}
          >
            {!confirmingForget ? (
              <button
                type="button"
                className="btn btn-link"
                onClick={() => setConfirmingForget(true)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 12,
                  textDecoration: "underline",
                  width: "100%",
                }}
              >
                Forget this wallet on this device
              </button>
            ) : (
              <>
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    margin: "0 0 8px",
                    lineHeight: 1.4,
                  }}
                >
                  This removes the wallet from this device only. Your
                  funds stay where they are -- you can restore the
                  wallet later via Recover. Continue?
                </p>
                <button
                  type="button"
                  className="btn btn-secondary btn-full"
                  onClick={forgetCurrentAccount}
                  disabled={forgetting}
                  style={{ marginBottom: 4 }}
                >
                  {forgetting ? "Forgetting..." : "Yes, forget this wallet"}
                </button>
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => setConfirmingForget(false)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                    textDecoration: "underline",
                    width: "100%",
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>

          <button
            className="btn btn-link"
            type="button"
            onClick={onCancel}
            style={{
              marginTop: 8,
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
              textDecoration: "underline",
              width: "100%",
            }}
          >
            Lock wallet
          </button>
        </div>
      )}
    </div>
  );
}
