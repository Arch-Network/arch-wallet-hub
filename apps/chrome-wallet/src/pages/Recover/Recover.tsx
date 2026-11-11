/**
 * Email-OTP recovery flow.
 *
 * Entry points (all land here):
 *
 *   - Settings -> "Recover via email" on an existing wallet sends
 *     ?externalUserId=<active>. We pre-fill the user's email if
 *     unlocked state has it on file, the Hub returns exactly one
 *     candidate, and the wallet-pick step is skipped.
 *
 *   - Unlock screen -> "Recover via email" (forgot password) drops
 *     the user here with no params. The user types an email, the
 *     Hub returns 0..N candidates, the user picks one, and we
 *     rebind the local install id to the recovered externalUserId
 *     once recovery completes.
 *
 *   - Fresh-device recovery: same path as "forgot password" -- the
 *     install id is regenerated locally on first run so the user
 *     also has no externalUserId in the URL.
 *
 * Flow (branches on the verify response's authMethod):
 *
 *   email -> otp -> (account-pick if >1 candidate) -> password ->
 *     [authMethod === "passkey":
 *        decrypt bundle -> WebAuthn create -> CREATE_AUTHENTICATORS
 *        stamped with recovered API key -> seal fresh keystore
 *      authMethod === "email":
 *        seal fresh keystore -> openEmailSession with the same
 *        bundle (saves a redundant OTP cycle on first unlock)]
 *     -> done
 *
 * Security notes:
 *
 *   - The recovered API key never crosses the wire in plaintext; the
 *     Hub returns an HPKE-encrypted credentialBundle that we decrypt
 *     locally using the private half of the ephemeral keypair we
 *     generated at the start of the verify call.
 *
 *   - We always require a fresh password. The keystore is re-sealed;
 *     the previous keystore (if any) is overwritten by
 *     walletStore.completeOnboarding. The password is never written
 *     to the recovery checkpoint. The verified bundle is, so a window
 *     that still closes while the user copies a password reopens on
 *     this step instead of asking for a code Turnkey already spent.
 *
 *   - A user who hits this screen with no externalUserId is in the
 *     fresh-device or forgot-password case. After completeOnboarding
 *     we call walletStore.setInstallId so subsequent Hub calls map
 *     to the recovered account.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  WalletHubClient,
  type RecoveryEmailCandidate,
} from "@arch-network/wallet-hub-sdk";
import { TurnkeyClient } from "@turnkey/http";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { walletStore } from "../../state/wallet-store";
import { scorePasswordStrength } from "../../crypto/keystore";
import { deriveArchAccountAddress } from "../../utils/sdk";
import {
  decryptRecoveryBundle,
  generateRecoveryKeypair,
} from "../../crypto/turnkey-bundle";
import {
  clearRecoverySession,
  isSpentRecoveryChallenge,
  loadRecoverySession,
  saveRecoverySession,
} from "../../state/recovery-session";
import {
  DEFAULT_HUB_API_KEY,
  DEFAULT_HUB_BASE_URL,
  type WalletAccount,
} from "../../state/types";
import { createArchPasskey } from "../../session/passkey-hosted";
import { passkeyUserName } from "../../session/passkey-webauthn";
import { resolveRecoveredHubResourceId } from "../../utils/hub-resource";

type Step = "email" | "otp" | "pick" | "password" | "done";

interface RecoverProps {
  onRecovered: () => void;
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <div style={{ width: "100%", display: "flex", justifyContent: "flex-start" }}>
      <button
        type="button"
        onClick={onClick}
        title="Back to unlock"
        aria-label="Back to unlock"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: "transparent",
          border: "1px solid var(--border-primary)",
          color: "var(--text-secondary)",
          padding: "6px 10px",
          borderRadius: 6,
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back
      </button>
    </div>
  );
}

function candidateAuthLabel(candidate: RecoveryEmailCandidate): string {
  return candidate.authMethod === "email" ? "Email wallet" : "Passkey wallet";
}

function candidateAddressLabel(candidate: RecoveryEmailCandidate): string {
  if (candidate.defaultAddress) {
    return candidate.defaultAddress.length > 18
      ? `${candidate.defaultAddress.slice(0, 10)}...${candidate.defaultAddress.slice(-6)}`
      : candidate.defaultAddress;
  }
  return candidate.addressMasked || "Address unavailable";
}

function candidateCreatedLabel(candidate: RecoveryEmailCandidate): string {
  if (!candidate.createdAt) return "Created date unavailable";
  const date = new Date(candidate.createdAt);
  if (Number.isNaN(date.getTime())) return "Created date unavailable";
  return `Created ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]);
}

async function waitForTurnkeyActivity(
  client: TurnkeyClient,
  organizationId: string,
  activityId: string,
): Promise<void> {
  const maxAttempts = 60;
  const delayMs = 500;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await client.getActivity({ organizationId, activityId });
    const activity = res.activity;
    if (activity.status === "ACTIVITY_STATUS_COMPLETED") return;
    if (
      activity.status === "ACTIVITY_STATUS_FAILED" ||
      activity.status === "ACTIVITY_STATUS_REJECTED" ||
      activity.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED"
    ) {
      throw new Error(`Turnkey recovery passkey registration failed: ${activity.status}`);
    }
    await sleep(delayMs);
  }

  throw new Error("Timed out waiting for Turnkey to register the recovery passkey");
}

export default function Recover({ onRecovered }: RecoverProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const pinnedExternalUserId = searchParams.get("externalUserId") ?? null;
  const pinnedResourceId = searchParams.get("resourceId") ?? null;

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<RecoveryEmailCandidate[]>([]);
  const [pickedToken, setPickedToken] = useState<string | null>(null);
  // Ephemeral P-256 key the Hub-returned credentialBundle is encrypted
  // to. After verify it is also in the session checkpoint so this
  // screen can reopen; cleared when recovery finishes or the user backs out.
  const [ephemeralPrivateKeyHex, setEphemeralPrivateKeyHex] = useState<
    string | null
  >(null);
  const [verifyResult, setVerifyResult] = useState<
    | {
        credentialBundle: string;
        organizationId: string;
        rootUserId: string | null;
        walletId: string | null;
        /** Hub resource primary key. Older hubs omit it. */
        resourceId: string | null;
        defaultAddress: string | null;
        defaultPublicKeyHex: string | null;
        externalUserId: string | null;
        authMethod: "passkey" | "email";
      }
    | null
  >(null);
  const [emailMasked, setEmailMasked] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  // Courtesy throttle for the OTP-step resend. The Hub owns the real
  // per-challenge cooldown/cap; this just stops the user spamming it.
  const [resendCooldown, setResendCooldown] = useState(0);

  // Case (a) bootstrap: if the URL carries an externalUserId, try to
  // pre-fill the email from a previously-recorded recovery email on
  // the active account. The store may be locked, in which case we
  // silently fall back to the email step.
  useEffect(() => {
    if (!pinnedExternalUserId) return;
    (async () => {
      try {
        const account = await walletStore.getActiveAccount();
        if (account?.recoveryEmail) setEmail(account.recoveryEmail);
      } catch {
        // Locked store; user will type it in.
      }
    })();
  }, [pinnedExternalUserId]);

  // Resume when the window closed mid-recovery. OTP and wallet-pick
  // come back as they were. A verified password step comes back as
  // the password form — the code is already spent, so restoring OTP
  // would 410. The restoreAttempted ref protects against a late load
  // clobbering something the user has started typing.
  const restoreAttempted = useRef(false);
  useEffect(() => {
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;
    (async () => {
      const checkpoint = await loadRecoverySession();
      if (!checkpoint) return;
      // If the URL also pins an externalUserId, make sure it matches.
      // Otherwise the user navigated here via a different entry point
      // and we shouldn't auto-resume someone else's flow.
      if (
        (pinnedExternalUserId &&
          checkpoint.pinnedExternalUserId &&
          pinnedExternalUserId !== checkpoint.pinnedExternalUserId) ||
        (pinnedResourceId &&
          checkpoint.pinnedResourceId &&
          pinnedResourceId !== checkpoint.pinnedResourceId)
      ) {
        await clearRecoverySession();
        return;
      }
      if (checkpoint.email) setEmail(checkpoint.email);
      if (checkpoint.challengeId) setChallengeId(checkpoint.challengeId);
      if (checkpoint.candidates?.length) setCandidates(checkpoint.candidates);
      if (checkpoint.emailMasked) setEmailMasked(checkpoint.emailMasked);
      if (checkpoint.pickedToken) setPickedToken(checkpoint.pickedToken);
      if (checkpoint.step === "password" && checkpoint.verified) {
        const verified = checkpoint.verified;
        setEphemeralPrivateKeyHex(verified.ephemeralPrivateKeyHex);
        setVerifyResult({
          credentialBundle: verified.credentialBundle,
          organizationId: verified.organizationId,
          rootUserId: verified.rootUserId,
          walletId: verified.walletId,
          resourceId: verified.resourceId,
          defaultAddress: verified.defaultAddress,
          defaultPublicKeyHex: verified.defaultPublicKeyHex,
          externalUserId: verified.externalUserId,
          authMethod: verified.authMethod,
        });
        setStep("password");
        return;
      }
      if (checkpoint.step === "otp" || checkpoint.step === "pick") {
        if (checkpoint.candidates?.length) {
          setStep(checkpoint.step);
        } else {
          await clearRecoverySession();
        }
      }
    })();
  }, [pinnedExternalUserId, pinnedResourceId]);

  // Persist the in-flight checkpoint whenever the resumable surface
  // changes. Nothing to resume at email or done. The password the
  // user is typing is not included. Writes are ordered inside
  // saveRecoverySession so a slow OTP save cannot clobber this.
  useEffect(() => {
    if (step === "password") {
      if (!verifyResult || !ephemeralPrivateKeyHex) return;
      void saveRecoverySession({
        step,
        email,
        challengeId,
        candidates,
        emailMasked,
        pickedToken,
        pinnedExternalUserId,
        pinnedResourceId,
        verified: {
          credentialBundle: verifyResult.credentialBundle,
          organizationId: verifyResult.organizationId,
          rootUserId: verifyResult.rootUserId,
          walletId: verifyResult.walletId,
          resourceId: verifyResult.resourceId,
          defaultAddress: verifyResult.defaultAddress,
          defaultPublicKeyHex: verifyResult.defaultPublicKeyHex,
          externalUserId: verifyResult.externalUserId,
          authMethod: verifyResult.authMethod,
          ephemeralPrivateKeyHex,
        },
      });
      return;
    }
    if (step !== "otp" && step !== "pick") return;
    if (!challengeId) return;
    if (candidates.length === 0) return;
    void saveRecoverySession({
      step,
      email,
      challengeId,
      candidates,
      emailMasked,
      pickedToken,
      pinnedExternalUserId,
      pinnedResourceId,
    });
  }, [step, email, challengeId, candidates, emailMasked, pickedToken, pinnedExternalUserId, pinnedResourceId, verifyResult, ephemeralPrivateKeyHex]);

  const buildClient = useCallback(async () => {
    const state = await walletStore.getState().catch(() => null);
    const apiKey = state?.hubApiKey || DEFAULT_HUB_API_KEY || "";
    if (!apiKey) {
      throw new Error(
        "Missing Wallet Hub API key. Set WXT_HUB_API_KEY_DEV in apps/chrome-wallet/.env.local and rebuild.",
      );
    }
    return new WalletHubClient({
      baseUrl: state?.hubBaseUrl || DEFAULT_HUB_BASE_URL,
      ...(apiKey ? { apiKey } : {}),
    });
  }, []);

  const abandonSpentChallenge = useCallback(async () => {
    await clearRecoverySession();
    setChallengeId(null);
    setCandidates([]);
    setPickedToken(null);
    setOtp("");
    setVerifyResult(null);
    setEphemeralPrivateKeyHex(null);
    setEmailMasked("");
    setStep("email");
    setError(
      "That code was already used. Request a new one. Your email is still filled in.",
    );
  }, []);

  const startOtpForCandidate = useCallback(async (
    selectedChallengeId: string,
    candidateToken: string,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const client = await buildClient();
      const res = await client.startRecoveryEmailOtp({
        challengeId: selectedChallengeId,
        candidateToken,
        email: email.trim(),
      });
      if (res.emailMasked) setEmailMasked(res.emailMasked);
      setChallengeId(selectedChallengeId);
      setPickedToken(candidateToken);
      setOtp("");
      setStep("otp");
    } catch (e: any) {
      if (isSpentRecoveryChallenge(e)) {
        await abandonSpentChallenge();
        return;
      }
      setError(e?.message || "Failed to send verification code");
    } finally {
      setLoading(false);
    }
  }, [buildClient, email, abandonSpentChallenge]);

  // Tick the resend cooldown down to zero.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  // Resend on the OTP step re-sends the code on the *existing*
  // challenge (same candidate) instead of re-running init, which would
  // mint a fresh challengeId and orphan the in-flight OTP (issue #57).
  const resendOtp = useCallback(async () => {
    if (!challengeId || !pickedToken || resending || resendCooldown > 0) {
      return;
    }
    setResending(true);
    setError(null);
    try {
      const client = await buildClient();
      const res = await client.startRecoveryEmailOtp({
        challengeId,
        candidateToken: pickedToken,
        email: email.trim(),
      });
      if (res.emailMasked) setEmailMasked(res.emailMasked);
      setOtp("");
      setResendCooldown(30);
    } catch (e: any) {
      if (isSpentRecoveryChallenge(e)) {
        await abandonSpentChallenge();
        return;
      }
      // Neutral 429 from the Hub when resends are too frequent / over
      // the cap: surface the message and keep the user on the OTP step.
      setError(e?.message || "Failed to resend verification code");
      setResendCooldown(30);
    } finally {
      setResending(false);
    }
  }, [challengeId, pickedToken, email, resending, resendCooldown, buildClient, abandonSpentChallenge]);

  const initOtp = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const client = await buildClient();
      const res = await client.initRecoveryEmail({ email: email.trim() });
      if (res.candidates.length === 0) {
        setChallengeId(null);
        setCandidates([]);
        setPickedToken(null);
        setEmailMasked(res.emailMasked);
        await clearRecoverySession();
        setError(
          "No verifiable wallets came back for that email yet. Check the spelling, wait if you've retried several times, or try a different email.",
        );
        setStep("email");
        return;
      }
      setChallengeId(res.challengeId);
      setCandidates(res.candidates);
      setEmailMasked(res.emailMasked);
      setPickedToken(null);
      const pinnedCandidate = pinnedResourceId
        ? res.candidates.find((c) => c.resourceId === pinnedResourceId)
        : null;
      if (pinnedResourceId && !pinnedCandidate) {
        setError("This email has wallet(s), but none match the active wallet.");
        setStep("email");
        return;
      }
      if (pinnedCandidate || res.candidates.length === 1) {
        await startOtpForCandidate(
          res.challengeId,
          (pinnedCandidate ?? res.candidates[0]!).candidateToken,
        );
      } else {
        setStep("pick");
      }
    } catch (e: any) {
      setError(e?.message || "Failed to send recovery email");
    } finally {
      setLoading(false);
    }
  }, [email, buildClient, startOtpForCandidate, pinnedResourceId]);

  const verifyOtp = useCallback(async () => {
    if (!challengeId) return;
    // Decide which candidate to verify against. Single-candidate or
    // pinned-externalUserId flows skip the picker; otherwise the user
    // must pick first.
    let token = pickedToken;
    if (!token) {
      if (candidates.length === 0) {
        setError("No wallets found for that email.");
        return;
      }
      if (candidates.length === 1) {
        token = candidates[0]!.candidateToken;
      } else {
        // Defer to the picker step.
        setStep("pick");
        return;
      }
    }
    setLoading(true);
    setError(null);
    try {
      const client = await buildClient();
      const keypair = await generateRecoveryKeypair();
      const res = await client.verifyRecoveryEmail({
        challengeId,
        candidateToken: token,
        code: otp.trim(),
        ephemeralPublicKey: keypair.publicKeyUncompressedHex,
        ...(pinnedExternalUserId
          ? { externalUserId: pinnedExternalUserId }
          : {}),
      });
      const verified = {
        credentialBundle: res.credentialBundle,
        organizationId: res.organizationId,
        rootUserId: res.rootUserId,
        walletId: res.walletId,
        resourceId:
          (res as { resourceId?: string | null }).resourceId ?? null,
        defaultAddress: res.defaultAddress,
        defaultPublicKeyHex: res.defaultPublicKeyHex,
        externalUserId: res.externalUserId,
        // Default to "passkey" for back-compat with Hubs predating
        // migration 011 that don't yet emit the field.
        authMethod: ((res as any).authMethod === "email" ? "email" : "passkey") as
          | "email"
          | "passkey",
      };
      // Write the checkpoint before showing the password step. If the
      // window still closes, the OTP effect must not be the last thing stored.
      await saveRecoverySession({
        step: "password",
        email,
        challengeId,
        candidates,
        emailMasked,
        pickedToken: token,
        pinnedExternalUserId,
        pinnedResourceId,
        verified: {
          ...verified,
          ephemeralPrivateKeyHex: keypair.privateKeyHex,
        },
      });
      setEphemeralPrivateKeyHex(keypair.privateKeyHex);
      setVerifyResult(verified);
      setStep("password");
    } catch (e: any) {
      if (isSpentRecoveryChallenge(e)) {
        await abandonSpentChallenge();
        return;
      }
      setError(e?.message || "Invalid or expired code");
    } finally {
      setLoading(false);
    }
  }, [challengeId, otp, pickedToken, candidates, pinnedExternalUserId, pinnedResourceId, email, emailMasked, buildClient, abandonSpentChallenge]);

  const completeRecovery = useCallback(async () => {
    if (!verifyResult || !ephemeralPrivateKeyHex) return;
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    setError(null);
    setStatusMessage("Decrypting recovery key...");
    try {
      const displayName =
        verifyResult.defaultAddress
          ? `Recovered ${verifyResult.defaultAddress.slice(-6)}`
          : "Recovered wallet";
      // Hub session and signing look this up as a resource primary key.
      // Turnkey's wallet id is a different column and 400s with
      // InvalidResource.
      const resourceId = await resolveRecoveredHubResourceId({
        resourceId: verifyResult.resourceId,
        walletId: verifyResult.walletId,
        organizationId: verifyResult.organizationId,
        publicKeyHex: verifyResult.defaultPublicKeyHex,
        externalUserId: verifyResult.externalUserId,
      });
      const baseAccount: WalletAccount = {
        id: resourceId,
        label: displayName,
        btcAddress: verifyResult.defaultAddress ?? "",
        publicKeyHex: verifyResult.defaultPublicKeyHex ?? "",
        archAddress: verifyResult.defaultPublicKeyHex
          ? deriveArchAccountAddress(verifyResult.defaultPublicKeyHex)
          : undefined,
        kind: "turnkey",
        turnkeyResourceId: resourceId,
        organizationId: verifyResult.organizationId,
        authMethod: verifyResult.authMethod,
        recoveryEmail: email.trim() || undefined,
        createdAt: Date.now(),
      };

      if (verifyResult.authMethod === "passkey") {
        // Passkey wallets: mint a fresh WebAuthn credential on this
        // device and attach it to the sub-org's root user via the
        // recovered API key. After this the user controls a brand-
        // new authenticator without losing the old one's history.
        if (!verifyResult.rootUserId) {
          throw new Error("Recovery target missing root user id; please retry.");
        }
        const client = await buildClient();
        const config = await client.getTurnkeyConfig();

        const recovered = decryptRecoveryBundle({
          credentialBundle: verifyResult.credentialBundle,
          ephemeralPrivateKeyHex,
        });

        setStatusMessage("Follow the passkey prompt.");
        const passkey = await withTimeout(
          createArchPasskey({
            apiBaseUrl: config.apiBaseUrl,
            organizationId: verifyResult.organizationId,
            userName: passkeyUserName(displayName),
            displayName,
          }),
          180_000,
          "Creating passkey",
        );

        setStatusMessage("Registering new passkey with Turnkey...");
        const stamper = new ApiKeyStamper({
          apiPublicKey: recovered.publicKeyHex,
          apiPrivateKey: recovered.privateKeyHex,
        });
        const tkHttp = new TurnkeyClient(
          { baseUrl: config.apiBaseUrl },
          stamper,
        );
        const createRes: any = await (tkHttp as any).createAuthenticators({
          type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2",
          timestampMs: String(Date.now()),
          organizationId: verifyResult.organizationId,
          parameters: {
            userId: verifyResult.rootUserId,
            authenticators: [
              {
                authenticatorName: `Recovery passkey ${new Date()
                  .toISOString()
                  .slice(0, 16)}`,
                challenge: passkey.encodedChallenge,
                attestation: passkey.attestation,
              },
            ],
          },
        });
        const activityId = createRes?.activity?.id;
        if (!activityId) {
          throw new Error("Turnkey did not return a passkey registration activity id");
        }

        setStatusMessage("Confirming passkey registration...");
        await waitForTurnkeyActivity(
          tkHttp,
          verifyResult.organizationId,
          activityId,
        );
        baseAccount.passkeyCredentialId = passkey.attestation.credentialId;
      }

      // Common tail: seal the keystore, persist the account, rebind
      // installId. For passkey wallets the next unlock will open a
      // session via WebAuthn; for email wallets we *also* immediately
      // burn the just-verified bundle to open the first IndexedDB
      // session, sparing the user a redundant OTP prompt seconds
      // after they typed one.
      setStatusMessage("Sealing wallet on this device...");
      if (verifyResult.externalUserId) {
        await walletStore.setInstallId(verifyResult.externalUserId);
      }
      await walletStore.completeOnboarding(password, baseAccount);

      if (verifyResult.authMethod === "email") {
        try {
          await walletStore.openEmailSession({
            credentialBundle: verifyResult.credentialBundle,
            ephemeralPrivateKeyHex,
          });
        } catch (e) {
          // Non-fatal: the session bootstrapper will pick this up
          // on the next route render and re-init OTP.
          console.warn("Initial email session bootstrap failed", e);
        }
      }

      setStatusMessage(null);
      setStep("done");
      // Flow finished -- drop the checkpoint so the next popup open
      // doesn't bounce the user back into recovery.
      void clearRecoverySession();
      onRecovered();
      setTimeout(() => navigate("/"), 1500);
    } catch (e: any) {
      setError(e?.message || "Failed to finalize recovery");
      setStatusMessage(null);
    } finally {
      setLoading(false);
    }
  }, [
    verifyResult,
    ephemeralPrivateKeyHex,
    password,
    confirm,
    email,
    buildClient,
    navigate,
    onRecovered,
  ]);

  const otpHint = useMemo(() => {
    if (!emailMasked) return null;
    return (
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
        If a wallet exists for {emailMasked}, you'll receive a 6-digit code.
      </div>
    );
  }, [emailMasked]);

  if (step === "done") {
    return (
      <div className="onboarding">
        <div className="onboarding-logo">
          <img src="/arch-mark-orange.svg" alt="Arch" className="brand-swap-light" style={{ width: 64, height: 64 }} />
        <img src="/arch-mark-white.svg" alt="Arch" className="brand-swap-dark" style={{ width: 64, height: 64 }} />
        </div>
        <h1 className="onboarding-title">Recovery complete</h1>
        <p className="onboarding-sub">
          A new passkey is attached. Reopening the wallet...
        </p>
      </div>
    );
  }

  return (
    <div className="onboarding">
      <BackButton
        onClick={() => {
          // Explicit exit from recovery -- discard the checkpoint so
          // we don't yank the user back here on the next popup open.
          void clearRecoverySession();
          navigate("/");
        }}
      />

      <div className="onboarding-logo">
        <img src="/arch-mark-orange.svg" alt="Arch" className="brand-swap-light" style={{ width: 64, height: 64 }} />
        <img src="/arch-mark-white.svg" alt="Arch" className="brand-swap-dark" style={{ width: 64, height: 64 }} />
      </div>
      <h1 className="onboarding-title">Recover wallet</h1>
      <p className="onboarding-sub">
        {pinnedExternalUserId
          ? "Replace this device's passkey using your recovery email."
          : "Enter the email you used at sign-up to find your wallet."}
      </p>

      {error && <div className="error-banner">{error}</div>}
      {statusMessage && (
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {statusMessage}
        </div>
      )}

      {step === "email" && (
        <>
          <div style={{ marginBottom: 12, textAlign: "left", width: "100%" }}>
            <label className="input-label">Email</label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={{ width: "100%", boxSizing: "border-box" }}
              autoComplete="email"
            />
          </div>
          <button
            className="btn btn-primary btn-full"
            onClick={initOtp}
            disabled={loading || !email}
          >
            {loading ? "Sending..." : "Send code"}
          </button>
        </>
      )}

      {step === "otp" && (
        <>
          {otpHint}
          {candidates.length === 0 ? (
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                marginBottom: 8,
                lineHeight: 1.5,
              }}
            >
              No verifiable wallets came back for that email yet.
              This usually means one of two things:
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                <li>
                  No wallet uses that email -- check the spelling and
                  retry.
                </li>
                <li>
                  You've tried a few times in the last hour. The
                  recovery service throttles per email; wait a bit
                  and the next attempt should pick up your wallet.
                </li>
              </ul>
              <button
                type="button"
                className="btn btn-secondary btn-full"
                style={{ marginTop: 12 }}
                onClick={() => {
                  setOtp("");
                  setChallengeId(null);
                  setEmailMasked("");
                  void clearRecoverySession();
                  setStep("email");
                }}
              >
                Try a different email
              </button>
            </div>
          ) : (
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
                />
              </div>
              <button
                className="btn btn-primary btn-full"
                onClick={verifyOtp}
                disabled={loading || !otp}
              >
                {loading ? "Verifying..." : "Verify"}
              </button>
              <button
                className="btn btn-link"
                type="button"
                onClick={resendOtp}
                disabled={loading || resending || resendCooldown > 0}
                style={{
                  marginTop: 8,
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor:
                    loading || resending || resendCooldown > 0
                      ? "default"
                      : "pointer",
                  fontSize: 12,
                  textDecoration: "underline",
                }}
              >
                {resending
                  ? "Resending..."
                  : resendCooldown > 0
                    ? `Resend code in ${resendCooldown}s`
                    : "Resend code"}
              </button>
            </>
          )}
        </>
      )}

      {step === "pick" && (
        <>
          <p
            style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              marginBottom: 8,
            }}
          >
            Multiple wallets are registered to this email. Pick the wallet
            first; we'll send a one-time code for only that wallet.
          </p>
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
            {candidates.map((c) => (
              <button
                key={c.candidateToken}
                type="button"
                disabled={loading}
                onClick={() => {
                  if (!challengeId) return;
                  void startOtpForCandidate(challengeId, c.candidateToken);
                }}
                style={{
                  background: "var(--bg-card)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: 8,
                  padding: "10px 12px",
                  textAlign: "left",
                  color: "var(--text-primary)",
                  cursor: loading ? "default" : "pointer",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>{candidateAuthLabel(c)}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {candidateAddressLabel(c)}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {candidateCreatedLabel(c)}
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {step === "password" && (
        <>
          <p
            style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            Email verified. Set a password to seal the wallet on this
            device; you'll be asked to create a new passkey next. This
            window stays open while you copy that password from another app.
          </p>
          <div style={{ marginBottom: 8, textAlign: "left", width: "100%" }}>
            <label className="input-label">New password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              style={{ width: "100%", boxSizing: "border-box" }}
              autoComplete="new-password"
            />
            {password && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: "var(--text-muted)",
                }}
              >
                Strength: {scorePasswordStrength(password).label}
              </div>
            )}
          </div>
          <div style={{ marginBottom: 12, textAlign: "left", width: "100%" }}>
            <label className="input-label">Confirm</label>
            <input
              className="input"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter password"
              style={{ width: "100%", boxSizing: "border-box" }}
              autoComplete="new-password"
            />
          </div>
          <button
            className="btn btn-primary btn-full"
            onClick={completeRecovery}
            disabled={loading || !password || password !== confirm}
          >
            {loading ? statusMessage ?? "Finalizing..." : "Recover wallet"}
          </button>
        </>
      )}
    </div>
  );
}
