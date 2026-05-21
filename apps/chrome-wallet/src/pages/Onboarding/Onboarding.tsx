import { useState, useCallback, useEffect, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { WalletHubClient } from "@arch-network/wallet-hub-sdk";
import { Turnkey } from "@turnkey/sdk-browser";
import { walletStore } from "../../state/wallet-store";
import { keystore, scorePasswordStrength } from "../../crypto/keystore";
import { getExternalUserId, invalidateClientCache, deriveArchAccountAddress } from "../../utils/sdk";
import { isInSidePanel, openWalletPopup } from "../../utils/runtime-context";
import {
  DEFAULT_HUB_API_KEY,
  DEFAULT_HUB_BASE_URL,
  type ExternalWalletProvider,
  type WalletAccount,
} from "../../state/types";
import { PASSKEY_RP_ID } from "../../session/constants";
import RecoveryDisclosure from "../../components/RecoveryDisclosure";
import ArchLogoAnimated from "../../components/ArchLogoAnimated";
import { externalWalletAdapters, getExternalWalletAdapter } from "../../wallets/external-wallets";

interface OnboardingProps {
  onComplete: () => void;
  /** When true we skip the welcome screen and go straight to wallet-type choice (used by "Add Wallet" from Settings) */
  addMode?: boolean;
  /**
   * When true the user already has a wallet but it was stored
   * unencrypted (legacy plaintext blob); we ask them to set a password
   * and seal it. The Hub creation flow is skipped entirely.
   */
  secureLegacyState?: unknown;
}

type Step = "welcome" | "secure" | "creating";

/**
 * The welcome flow is split into a wizard. Each value here maps
 * to one screen the user sees on their way to creating a wallet.
 *
 *   0 -- "method" : pick passkey vs email auth (two big choice
 *                   cards, no inputs)
 *   1 -- "details": ask for wallet name + recovery email. Email
 *                   required iff the chosen method is "email"
 *   2 -- "password": choose an unlock password. Skipped entirely
 *                   in addMode (a wallet exists already, so the
 *                   keystore password is already set).
 *
 * Progressive disclosure keeps the popup feeling lightweight --
 * the user is never staring at more than two inputs at a time.
 */
type WizardStep = 0 | 1 | 2;
type WizardMethod = "passkey" | "email" | "external" | null;

const MIN_PASSWORD_LENGTH = 8;
const ONBOARDING_HANDOFF_PREFIX = "arch_wallet_onboarding_handoff:";

/**
 * SECURITY: we deliberately do NOT carry the unlock password through
 * the side-panel -> popup handoff. `chrome.storage.session` is in
 * memory and not on disk, but is accessible to any execution context
 * within the extension origin (popup, sidepanel, service worker,
 * content scripts of extension pages) until the browser closes. A
 * future bug in an extension page (or a compromised dep that runs in
 * extension origin) would be able to read it.
 *
 * Instead, when the popup resumes onboarding, we reseat the wizard at
 * the password step (with the captured method/email/walletName) and
 * the user re-enters the password they chose moments ago. One extra
 * keystroke vs. a credential-leak class of bugs.
 */
interface OnboardingHandoff {
  method: "passkey" | "email";
  walletName: string;
  email: string;
  /**
   * The wizard step the user was on. The popup jumps back to the
   * password step (so the user can re-supply it) unless we are in
   * addMode (no password needed).
   */
  wizardStep: WizardStep;
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

interface PasswordFieldsProps {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
}

function PasswordFields({ password, confirm, onPassword, onConfirm }: PasswordFieldsProps) {
  const strength = scorePasswordStrength(password);
  const mismatch = !!confirm && confirm !== password;
  return (
    <>
      <div className="onboarding-field">
        <label className="onboarding-field-label">Password</label>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => onPassword(e.target.value)}
          placeholder="At least 8 characters"
          autoComplete="new-password"
        />
        {password && (
          <p
            className="onboarding-field-status"
            data-tone={strength.score >= 3 ? "success" : "muted"}
          >
            Strength: {strength.label}
          </p>
        )}
      </div>
      <div className="onboarding-field">
        <label className="onboarding-field-label">Confirm password</label>
        <input
          className="input"
          type="password"
          value={confirm}
          onChange={(e) => onConfirm(e.target.value)}
          placeholder="Re-enter your password"
          autoComplete="new-password"
        />
        {mismatch && (
          <p className="onboarding-field-status" data-tone="danger">
            Passwords do not match
          </p>
        )}
      </div>
    </>
  );
}

export default function Onboarding({ onComplete, addMode, secureLegacyState }: OnboardingProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [step, setStep] = useState<Step>(secureLegacyState ? "secure" : "welcome");
  const [error, setError] = useState<string | null>(null);
  const [walletName, setWalletName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [statusMessage, setStatusMessage] = useState("Setting up your wallet...");

  // Wizard substate. `wizardStep` is the current screen index;
  // `wizardMethod` is the auth-method selected on step 0. Both
  // persist as the user moves back/forward so they don't have to
  // re-pick when correcting an earlier field.
  const [wizardStep, setWizardStep] = useState<WizardStep>(0);
  const [wizardMethod, setWizardMethod] = useState<WizardMethod>(null);
  const [externalProvider, setExternalProvider] = useState<ExternalWalletProvider | null>(null);

  // `lastWizardStep` collapses the password screen out of the
  // flow when we're adding a wallet to an already-unlocked
  // keystore. Doing this here (instead of skipping conditionally
  // inside goNext) keeps the progress dot count honest.
  const lastWizardStep: WizardStep = addMode ? 1 : 2;
  const totalWizardSteps = lastWizardStep + 1;

  useEffect(() => {
    invalidateClientCache();
  }, []);

  useEffect(() => {
    if (secureLegacyState) return;
    const handoffId = searchParams.get("resumeOnboarding");
    if (!handoffId) return;

    let cancelled = false;
    (async () => {
      const key = `${ONBOARDING_HANDOFF_PREFIX}${handoffId}`;
      const result = await chrome.storage.session.get(key);
      const payload = result[key] as OnboardingHandoff | undefined;
      await chrome.storage.session.remove(key);
      if (cancelled || !payload) return;

      setWizardMethod(payload.method);
      setWalletName(payload.walletName);
      setEmail(payload.email);
      // Password is intentionally NOT carried through the handoff.
      // Reseat at the password step so the user re-enters it; the
      // captured method/email/walletName mean they only need to type
      // the password.
      setPassword("");
      setConfirmPassword("");
      setWizardStep(Math.min(payload.wizardStep, lastWizardStep) as WizardStep);

      const next = new URLSearchParams(searchParams);
      next.delete("resumeOnboarding");
      setSearchParams(next, { replace: true });
    })().catch(() => {
      const next = new URLSearchParams(searchParams);
      next.delete("resumeOnboarding");
      setSearchParams(next, { replace: true });
    });

    return () => {
      cancelled = true;
    };
  }, [secureLegacyState, searchParams, setSearchParams, lastWizardStep]);

  const buildClient = useCallback(async () => {
    const state = await walletStore.getState().catch(() => null);
    const apiKey = state?.hubApiKey || DEFAULT_HUB_API_KEY || "";
    if (!apiKey) {
      throw new Error(
        "Missing Wallet Hub API key. Set WXT_HUB_API_KEY_DEV in apps/chrome-wallet/.env.local and rebuild, or add the key in Settings after onboarding.",
      );
    }
    return new WalletHubClient({
      baseUrl: state?.hubBaseUrl || DEFAULT_HUB_BASE_URL,
      ...(apiKey ? { apiKey } : {}),
    });
  }, []);

  const networkForHub = useCallback(async () => {
    const state = await walletStore.getState().catch(() => null);
    return state?.network === "mainnet" ? "mainnet" : "testnet";
  }, []);

  const finishOnboarding = useCallback(() => {
    onComplete();
    if (addMode) {
      navigate("/dashboard");
    }
  }, [onComplete, addMode, navigate]);

  const validatePassword = useCallback((): string | null => {
    if (!addMode) {
      if (password.length < MIN_PASSWORD_LENGTH)
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
      if (password !== confirmPassword) return "Passwords do not match";
    }
    return null;
  }, [password, confirmPassword, addMode]);

  // Phase 1.1 + 1.10: Seal a legacy plaintext state under a fresh password.
  const sealLegacyAndExit = useCallback(async () => {
    setStep("creating");
    setStatusMessage("Securing your wallet...");
    setError(null);
    try {
      const err = validatePassword();
      if (err) throw new Error(err);
      await walletStore.sealLegacyState(password, secureLegacyState);
      finishOnboarding();
    } catch (e: any) {
      setError(e?.message || "Failed to secure wallet");
      setStep("secure");
    }
  }, [password, secureLegacyState, validatePassword, finishOnboarding]);

  const createNonCustodialWallet = useCallback(async () => {
    const err = validatePassword();
    if (err) {
      setError(err);
      return;
    }
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Recovery email is required for passkey wallets");
      return;
    }
    if (isInSidePanel()) {
      try {
        const handoffId =
          self.crypto?.randomUUID?.() ??
          `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await chrome.storage.session.set({
          [`${ONBOARDING_HANDOFF_PREFIX}${handoffId}`]: {
            method: "passkey",
            walletName,
            email: trimmedEmail,
            // password is intentionally omitted from the handoff;
            // the popup re-prompts. See OnboardingHandoff comment.
            wizardStep: lastWizardStep,
          } satisfies OnboardingHandoff,
        });
        await openWalletPopup({
          path: addMode ? "/add-wallet" : "/",
          query: {
            resumeOnboarding: handoffId,
          },
        });
        setError(
          "Continue in the popup window to create a passkey. The side panel can't show passkey prompts.",
        );
      } catch (e: any) {
        setError(e?.message || "Could not open the wallet popup");
      }
      return;
    }
    setStep("creating");
    setError(null);
    setStatusMessage("Fetching server configuration...");
    try {
      const client = await buildClient();
      const externalUserId = await getExternalUserId();

      const config = await withTimeout(
        client.getTurnkeyConfig(),
        15_000,
        "Fetching server configuration",
      );

      // SECURITY: use the pinned PASSKEY_RP_ID constant; never derive
      // rpId from `location.hostname` (would silently rebind passkeys
      // across extension-id changes / popup vs tab contexts).
      const rpId = PASSKEY_RP_ID;

      setStatusMessage("Creating passkey - follow the browser prompt...");

      const tk = new Turnkey({
        apiBaseUrl: config.apiBaseUrl,
        defaultOrganizationId: config.organizationId,
        rpId,
      });

      const displayName = walletName.trim() || "Arch Wallet";
      const passkey = await withTimeout(
        tk.passkeyClient().createUserPasskey({
          publicKey: {
            rp: { id: rpId, name: "Arch Wallet" },
            user: { name: `${externalUserId}-${Date.now()}`, displayName },
            // SECURITY: enforce user verification (biometric / PIN /
            // device-PIN) on the registration ceremony. Presence-only
            // authenticators (button-tap-only security keys) are
            // rejected.
            authenticatorSelection: {
              userVerification: "required",
              residentKey: "preferred",
            },
          },
        }),
        30_000,
        "Creating passkey",
      );

      setStatusMessage("Creating your wallet on the server...");

      const idempotencyKey =
        self.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const result = await withTimeout(
        client.createTurnkeyPasskeyWallet({
          idempotencyKey,
          body: {
            externalUserId,
            userEmail: trimmedEmail,
            passkey: {
              challenge: passkey.encodedChallenge,
              attestation: passkey.attestation,
            },
          },
        }),
        45_000,
        "Creating wallet on the server",
      );

      const account: WalletAccount = {
        id: result.resourceId,
        label: walletName.trim() || "Passkey Wallet",
        btcAddress: result.defaultAddress ?? "",
        publicKeyHex: result.defaultPublicKeyHex ?? "",
        archAddress: result.defaultPublicKeyHex
          ? deriveArchAccountAddress(result.defaultPublicKeyHex)
          : undefined,
        kind: "turnkey",
        turnkeyResourceId: result.resourceId,
        organizationId: result.organizationId,
        authMethod: "passkey",
        passkeyCredentialId: passkey.attestation.credentialId,
        recoveryEmail: trimmedEmail,
        // Passkey wallets recover by re-attaching a new passkey via
        // the email recovery flow.
        createdAt: Date.now(),
      };

      if (addMode) {
        // Adding to an unlocked wallet -- no need to seal a new keystore.
        await walletStore.addAccount(account);
      } else {
        await walletStore.completeOnboarding(password, account);
      }
      finishOnboarding();
    } catch (e: any) {
      setError(e?.message || "Failed to create passkey wallet");
      setStep("welcome");
    }
  }, [finishOnboarding, buildClient, addMode, walletName, email, password, validatePassword]);

  /**
   * Create an email-only sub-org wallet. The Hub returns a sub-org
   * with no authenticators or API keys; the user bootstraps a
   * session credential later via OTP_AUTH. The recovery email is
   * non-optional in this path.
   */
  const createEmailWallet = useCallback(async () => {
    const err = validatePassword();
    if (err) {
      setError(err);
      return;
    }
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Email is required to create an email wallet");
      return;
    }
    setStep("creating");
    setError(null);
    setStatusMessage("Creating email wallet on the server...");
    try {
      const client = await buildClient();
      const externalUserId = await getExternalUserId();
      const idempotencyKey =
        self.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const result = await withTimeout(
        client.createTurnkeyEmailWallet({
          idempotencyKey,
          body: {
            externalUserId,
            userEmail: trimmedEmail,
          },
        }),
        45_000,
        "Creating email wallet on the server",
      );

      const account: WalletAccount = {
        id: result.resourceId,
        label: walletName.trim() || "Email Wallet",
        btcAddress: result.defaultAddress ?? "",
        publicKeyHex: result.defaultPublicKeyHex ?? "",
        archAddress: result.defaultPublicKeyHex
          ? deriveArchAccountAddress(result.defaultPublicKeyHex)
          : undefined,
        kind: "turnkey",
        turnkeyResourceId: result.resourceId,
        organizationId: result.organizationId,
        authMethod: "email",
        recoveryEmail: trimmedEmail,
        // Email wallets recover by re-running OTP verification to
        // bootstrap a fresh local signing session.
        createdAt: Date.now(),
      };

      if (addMode) {
        await walletStore.addAccount(account);
      } else {
        await walletStore.completeOnboarding(password, account);
      }
      finishOnboarding();
    } catch (e: any) {
      setError(e?.message || "Failed to create email wallet");
      setStep("welcome");
    }
  }, [finishOnboarding, buildClient, addMode, walletName, email, password, validatePassword]);

  const connectExternalWallet = useCallback(async () => {
    const err = validatePassword();
    if (err) {
      setError(err);
      return;
    }
    if (!externalProvider) {
      setError("Choose a wallet to connect");
      return;
    }
    setStep("creating");
    setError(null);
    setStatusMessage("Connecting to your wallet...");
    let phase: string = "init";
    try {
      phase = "buildClient";
      console.log("[ArchWallet] external onboarding:", phase);
      const client = await buildClient();
      const state = await walletStore.getState().catch(() => null);
      const network = state?.network ?? "testnet4";
      const hubNetwork = await networkForHub();
      const externalUserId = await getExternalUserId();
      const adapter = getExternalWalletAdapter(externalProvider);

      phase = "adapter.connect";
      console.log("[ArchWallet] external onboarding:", phase);
      const connected = await withTimeout(
        adapter.connect(network),
        30_000,
        `Connecting ${adapter.label}`,
      );

      setStatusMessage("Preparing ownership challenge...");
      phase = "createWalletLinkChallenge";
      console.log("[ArchWallet] external onboarding:", phase, {
        externalUserId,
        walletProvider: connected.provider,
        address: connected.address,
        network: hubNetwork,
      });
      const challenge = await withTimeout(
        client.createWalletLinkChallenge({
          externalUserId,
          walletProvider: connected.provider,
          address: connected.address,
          network: hubNetwork,
        }),
        15_000,
        "Creating wallet-link challenge",
      );

      setStatusMessage(`Confirm ownership in ${adapter.label}...`);
      phase = "adapter.signMessage";
      console.log("[ArchWallet] external onboarding:", phase);
      const signed = await withTimeout(
        adapter.signMessage({
          address: connected.address,
          message: challenge.message,
          network,
        }),
        60_000,
        `Signing with ${adapter.label}`,
      );

      setStatusMessage("Verifying linked wallet...");
      phase = "verifyWalletLinkChallenge";
      console.log("[ArchWallet] external onboarding:", phase, {
        challengeId: challenge.challengeId,
        schemeHint: signed.schemeHint,
      });
      const verified = await withTimeout(
        client.verifyWalletLinkChallenge({
          externalUserId,
          challengeId: challenge.challengeId,
          signature: signed.signature,
          schemeHint: signed.schemeHint,
        }),
        15_000,
        "Verifying wallet link",
      );

      const account: WalletAccount = {
        id: verified.linkedWalletId,
        label: walletName.trim() || `${adapter.label} Wallet`,
        btcAddress: verified.address,
        publicKeyHex: connected.publicKeyHex,
        archAddress:
          verified.archAccountAddress ||
          (connected.publicKeyHex ? deriveArchAccountAddress(connected.publicKeyHex) : undefined),
        kind: "external",
        turnkeyResourceId: "",
        organizationId: "",
        authMethod: "external",
        externalProvider: connected.provider,
        linkedWalletId: verified.linkedWalletId,
        verificationScheme: verified.verificationScheme,
        createdAt: Date.now(),
      };

      phase = addMode ? "walletStore.addAccount" : "walletStore.completeOnboarding";
      console.log("[ArchWallet] external onboarding:", phase);
      if (addMode) {
        await walletStore.addAccount(account);
      } else {
        await walletStore.completeOnboarding(password, account);
      }
      finishOnboarding();
    } catch (e: any) {
      console.error("[ArchWallet] external onboarding failed at phase:", phase, e);
      setError(`[${phase}] ${e?.message || "Failed to connect external wallet"}`);
      setStep("welcome");
    } finally {
      // Tear down the background-managed connector popup regardless of
      // success/failure. Background also auto-closes on idle as a
      // belt-and-braces safety net.
      try {
        await chrome.runtime.sendMessage({ type: "CLOSE_EXTERNAL_CONNECTOR" });
      } catch {
        /* SW gone / no connector ever opened */
      }
    }
  }, [
    addMode,
    buildClient,
    externalProvider,
    finishOnboarding,
    networkForHub,
    password,
    validatePassword,
    walletName,
  ]);

  // ── Wizard navigation ──────────────────────────────────────
  //
  // The wizard is deliberately simple: a single linear flow with
  // back + next. Validation locks Next per-step; clicking the
  // final Next ("Create wallet") dispatches to the appropriate
  // creator based on `wizardMethod`.
  //
  // We *don't* surface a "skip recovery email" confirmation modal
  // anymore -- the email step's own hint text is honest about the
  // trade-off, and the wizard's progressive disclosure already
  // gives users time to consider. Adding a modal on top would
  // double-prompt for the same decision.

  const chooseMethod = useCallback((method: "passkey" | "email" | "external") => {
    setWizardMethod(method);
    setError(null);
    setWizardStep(1);
  }, []);

  const goNext = useCallback(() => {
    setError(null);
    setWizardStep((s) => Math.min(s + 1, lastWizardStep) as WizardStep);
  }, [lastWizardStep]);

  const goBack = useCallback(() => {
    setError(null);
    setWizardStep((s) => Math.max(s - 1, 0) as WizardStep);
  }, []);

  const submitWizard = useCallback(() => {
    if (wizardMethod === "passkey") void createNonCustodialWallet();
    else if (wizardMethod === "email") void createEmailWallet();
    else if (wizardMethod === "external") void connectExternalWallet();
  }, [wizardMethod, createNonCustodialWallet, createEmailWallet, connectExternalWallet]);

  // Per-step validity drives the Next button's disabled state.
  const detailsValid =
    wizardMethod === "external" ? Boolean(externalProvider) : email.trim().length > 0;
  const passwordValid =
    addMode ||
    (password.length >= MIN_PASSWORD_LENGTH && password === confirmPassword);
  const onLastStep = wizardStep === lastWizardStep;

  const nextDisabled =
    (wizardStep === 1 && !detailsValid) ||
    (wizardStep === 2 && !passwordValid);

  const handlePrimary = useCallback(() => {
    if (onLastStep) submitWizard();
    else goNext();
  }, [onLastStep, submitWizard, goNext]);

  // Used by the <form> wrappers below so pressing Enter inside any
  // input on steps 1/2 triggers the same Continue/Create action as
  // the primary button. We re-check `nextDisabled` here because the
  // submit button's `disabled` attribute alone won't stop an implicit
  // form submission when validation flips between renders.
  const handleWizardSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (nextDisabled) return;
      handlePrimary();
    },
    [nextDisabled, handlePrimary],
  );

  if (step === "creating") {
    return (
      <div className="onboarding">
        <div className="spinner" style={{ width: 40, height: 40, borderWidth: 3 }} />
        <p style={{ color: "var(--text-secondary)" }}>{statusMessage}</p>
        <button
          type="button"
          className="btn btn-link"
          onClick={() => {
            setError("Wallet creation was cancelled. You can try again.");
            setStep("welcome");
          }}
          style={{
            marginTop: 12,
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            textDecoration: "underline",
          }}
        >
          Cancel and go back
        </button>
      </div>
    );
  }

  if (step === "secure") {
    const secureDisabled = !password || password !== confirmPassword;
    return (
      <div className="onboarding">
        <div className="onboarding-logo">
          <ArchLogoAnimated />
        </div>
        <h1 className="onboarding-title">Secure your wallet</h1>
        <p className="onboarding-sub">
          Set a password to encrypt your existing wallet on this device.
          You'll need it every time you unlock.
        </p>

        {error && <div className="error-banner">{error}</div>}

        <form
          className="onboarding-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (secureDisabled) return;
            void sealLegacyAndExit();
          }}
          noValidate
        >
          <div className="onboarding-card">
            <PasswordFields
              password={password}
              confirm={confirmPassword}
              onPassword={setPassword}
              onConfirm={setConfirmPassword}
            />
          </div>

          <div className="onboarding-actions">
            <button
              type="submit"
              className="btn btn-primary btn-full"
              disabled={secureDisabled}
            >
              Encrypt &amp; Continue
            </button>
          </div>
        </form>
      </div>
    );
  }

  // ── Wizard render ──────────────────────────────────────────
  //
  // Headers vary by step so the user always knows what one
  // decision is being asked of them right now.
  const stepHeading = (() => {
    if (wizardStep === 0) {
      return addMode ? "Add a wallet" : "Welcome to Arch Wallet";
    }
    if (wizardStep === 1) return "Wallet details";
    return "Set an unlock password";
  })();

  const stepSubhead = (() => {
    if (wizardStep === 0) {
      return addMode
        ? "Pick how this new wallet will sign in."
        : "Pick how you want to sign in. You can add another wallet later.";
    }
    if (wizardStep === 1) {
      if (wizardMethod === "external") return "Pick the wallet you already use.";
      return wizardMethod === "email"
        ? "We'll email a one-time code to this address whenever you unlock."
        : "Give the wallet a name and recovery email.";
    }
    return "You'll use this every time you open the wallet on this device.";
  })();

  return (
    <div className="onboarding">
      <div className="onboarding-logo">
        <ArchLogoAnimated />
      </div>

      <div className="onboarding-progress" aria-hidden="true">
        {Array.from({ length: totalWizardSteps }).map((_, i) => (
          <span
            key={i}
            className="onboarding-progress-dot"
            data-active={i === wizardStep ? "true" : "false"}
            data-done={i < wizardStep ? "true" : "false"}
          />
        ))}
      </div>

      <h1 className="onboarding-title">{stepHeading}</h1>
      <p className="onboarding-sub">{stepSubhead}</p>

      {error && <div className="error-banner">{error}</div>}

      {wizardStep === 0 && (
        <MethodChoiceStep onPick={chooseMethod} />
      )}

      {/* Steps 1 and 2 wrap their inputs + nav in a <form> so the
          browser's implicit "submit on Enter" behavior fires the
          primary action (Continue / Create wallet). The submit
          handler re-validates because the button's `disabled`
          attribute alone doesn't reliably block implicit submit
          across all browsers. */}
      {wizardStep > 0 && (
        <form className="onboarding-form" onSubmit={handleWizardSubmit} noValidate>
          {wizardStep === 1 && (
            wizardMethod === "external" ? (
              <ExternalProviderStep
                selected={externalProvider}
                walletName={walletName}
                onWalletName={setWalletName}
                onSelect={setExternalProvider}
              />
            ) : (
              <DetailsStep
                method={wizardMethod}
                walletName={walletName}
                email={email}
                onWalletName={setWalletName}
                onEmail={setEmail}
              />
            )
          )}

          {wizardStep === 2 && (
            <div className="onboarding-card">
              <PasswordFields
                password={password}
                confirm={confirmPassword}
                onPassword={setPassword}
                onConfirm={setConfirmPassword}
              />
            </div>
          )}

          <div className="onboarding-nav">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={goBack}
            >
              Back
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={nextDisabled}
            >
              {onLastStep
                ? wizardMethod === "passkey"
                  ? "Create with passkey"
                  : wizardMethod === "email"
                    ? "Create with email"
                    : "Connect wallet"
                : "Continue"}
            </button>
          </div>
        </form>
      )}

      {wizardStep === 0 && (
        <p className="onboarding-fineprint">
          Signing keys are non-extractable and stored only on this
          device. The server never sees them.
        </p>
      )}

      {/* Recover-existing exit: someone who already has a wallet
          (e.g. just forgot the local copy on this device, or
          re-installed the extension) should not have to scroll
          past the create-wallet wizard. Show it on step 0 only --
          once they've committed to a method/details we don't want
          to suggest abandoning the in-progress wizard. */}
      {wizardStep === 0 && !addMode && !secureLegacyState && (
        <div className="onboarding-recover-row">
          <span>Already have a wallet?</span>
          <button
            type="button"
            className="btn btn-link onboarding-recover-link"
            onClick={() => navigate("/recover")}
          >
            Recover via email
          </button>
        </div>
      )}

      {wizardStep === 0 && <RecoveryDisclosure />}
    </div>
  );
}

// ── Step components ──────────────────────────────────────────
//
// Kept inline in this file because they share state with the
// parent's controlled inputs and lifting them out would just
// add prop-drilling without re-use elsewhere.

interface MethodChoiceStepProps {
  onPick: (method: "passkey" | "email" | "external") => void;
}

function MethodChoiceStep({ onPick }: MethodChoiceStepProps) {
  return (
    <div className="onboarding-choice">
      <button
        type="button"
        className="onboarding-choice-card"
        onClick={() => onPick("passkey")}
      >
        <span className="onboarding-choice-card-icon" aria-hidden="true">
          {/* fingerprint glyph kept as SVG so it scales / themes
              with currentColor instead of needing a font asset. */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 11v4a3 3 0 0 0 3 3" />
            <path d="M8 8a4 4 0 0 1 8 0v5" />
            <path d="M4 12a8 8 0 0 1 16 0v3" />
            <path d="M9 21a8 8 0 0 0 3-6" />
          </svg>
        </span>
        <div className="onboarding-choice-card-body">
          <p className="onboarding-choice-card-title">
            Passkey
            <span className="onboarding-choice-card-badge">Recommended</span>
          </p>
          <p className="onboarding-choice-card-sub">
            One tap to unlock. Best on devices with Face ID, Touch ID,
            or a password manager.
          </p>
        </div>
      </button>

      <button
        type="button"
        className="onboarding-choice-card"
        onClick={() => onPick("email")}
      >
        <span className="onboarding-choice-card-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m3 7 9 6 9-6" />
          </svg>
        </span>
        <div className="onboarding-choice-card-body">
          <p className="onboarding-choice-card-title">Email</p>
          <p className="onboarding-choice-card-sub">
            One-time code at every unlock. Use if you don't have a
            passkey-capable device.
          </p>
        </div>
      </button>

      <button
        type="button"
        className="onboarding-choice-card"
        onClick={() => onPick("external")}
      >
        <span className="onboarding-choice-card-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 9h10" />
            <path d="M7 13h6" />
            <path d="M17 16l2 2 3-4" />
          </svg>
        </span>
        <div className="onboarding-choice-card-body">
          <p className="onboarding-choice-card-title">Connect existing wallet</p>
          <p className="onboarding-choice-card-sub">
            Keep funds in Xverse, UniSat, or Magic Eden while using Arch balances
            and supported signing flows.
          </p>
        </div>
      </button>
    </div>
  );
}

interface ExternalProviderStepProps {
  selected: ExternalWalletProvider | null;
  walletName: string;
  onWalletName: (v: string) => void;
  onSelect: (provider: ExternalWalletProvider) => void;
}

function ExternalProviderStep({
  selected,
  walletName,
  onWalletName,
  onSelect,
}: ExternalProviderStepProps) {
  return (
    <div className="onboarding-card">
      <div className="onboarding-field">
        <label className="onboarding-field-label">Account label</label>
        <input
          className="input"
          type="text"
          value={walletName}
          onChange={(e) => onWalletName(e.target.value)}
          placeholder="e.g. My Xverse Wallet"
          autoFocus
        />
        <p className="onboarding-field-hint">
          This only labels the linked wallet inside Arch Wallet.
        </p>
      </div>

      <div className="onboarding-divider" />

      <div className="onboarding-choice">
        {(Object.keys(externalWalletAdapters) as ExternalWalletProvider[]).map((provider) => {
          const adapter = externalWalletAdapters[provider];
          const installed = adapter.isInstalled();
          return (
            <button
              key={provider}
              type="button"
              className="onboarding-choice-card"
              aria-pressed={selected === provider}
              data-selected={selected === provider ? "true" : "false"}
              onClick={() => onSelect(provider)}
            >
              <span className="onboarding-choice-card-icon" aria-hidden="true">
                {adapter.label.slice(0, 1)}
              </span>
              <div className="onboarding-choice-card-body">
                <p className="onboarding-choice-card-title">
                  {adapter.label}
                  {!installed && (
                    <span className="onboarding-choice-card-badge">Not detected</span>
                  )}
                </p>
                <p className="onboarding-choice-card-sub">
                  You'll sign a message to prove ownership. Funds stay in your
                  existing wallet.
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface DetailsStepProps {
  method: WizardMethod;
  walletName: string;
  email: string;
  onWalletName: (v: string) => void;
  onEmail: (v: string) => void;
}

function DetailsStep({
  method,
  walletName,
  email,
  onWalletName,
  onEmail,
}: DetailsStepProps) {
  return (
    <div className="onboarding-card">
      <div className="onboarding-field">
        <label className="onboarding-field-label">Wallet name</label>
        <input
          className="input"
          type="text"
          value={walletName}
          onChange={(e) => onWalletName(e.target.value)}
          placeholder="e.g. My Daily Wallet"
          autoFocus
        />
        <p className="onboarding-field-hint">
          Just a label so you can tell wallets apart. You can rename
          it any time.
        </p>
      </div>

      <div className="onboarding-divider" />

      <div className="onboarding-field">
        <label className="onboarding-field-label">
          {method === "email" ? "Email" : "Recovery email"}
        </label>
        <input
          className="input"
          type="email"
          value={email}
          onChange={(e) => onEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
        />
        <p className="onboarding-field-hint">
          {method === "email"
            ? "Required - we'll send a verification code here at every unlock."
            : "Required - this is how you recover the wallet if you lose your passkey."}
        </p>
      </div>
    </div>
  );
}

