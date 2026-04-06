import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import { Turnkey } from "@turnkey/sdk-browser";
import { walletStore } from "../../state/wallet-store";
import { getExternalUserId, invalidateClientCache, deriveArchAccountAddress } from "../../utils/sdk";
import type { WalletAccount } from "../../state/types";

interface OnboardingProps {
  onComplete: () => void;
  /** When true we skip the welcome screen and go straight to wallet-type choice (used by "Add Wallet" from Settings) */
  addMode?: boolean;
}

type Step = "welcome" | "creating";

const DEFAULT_BASE_URL = "http://44.222.123.237:3005";

export default function Onboarding({ onComplete, addMode }: OnboardingProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("welcome");
  const [error, setError] = useState<string | null>(null);
  const [walletName, setWalletName] = useState("");
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState("");
  const [statusMessage, setStatusMessage] = useState("Setting up your wallet...");

  useEffect(() => {
    (async () => {
      const state = await walletStore.getState();
      if (state.apiBaseUrl) setApiBaseUrl(state.apiBaseUrl);
      if (state.apiKey) setApiKey(state.apiKey);
    })();
  }, []);

  const buildClient = useCallback(() => {
    return new WalletHubClient({
      baseUrl: apiBaseUrl || DEFAULT_BASE_URL,
      ...(apiKey ? { apiKey } : {}),
    });
  }, [apiBaseUrl, apiKey]);

  const saveApiConfig = useCallback(async () => {
    await walletStore.setApiConfig(
      apiBaseUrl || DEFAULT_BASE_URL,
      apiKey
    );
    invalidateClientCache();
  }, [apiBaseUrl, apiKey]);

  const finishOnboarding = useCallback(() => {
    onComplete();
    if (addMode) {
      navigate("/dashboard");
    }
  }, [onComplete, addMode, navigate]);

  const createNonCustodialWallet = useCallback(async () => {
    setStep("creating");
    setError(null);
    setStatusMessage("Fetching server configuration...");
    try {
      await saveApiConfig();
      const client = buildClient();
      const externalUserId = getExternalUserId();

      const config = await client.getTurnkeyConfig();

      const rpId =
        globalThis.location?.hostname === "localhost"
          ? "localhost"
          : globalThis.location?.hostname ?? "localhost";

      setStatusMessage("Creating passkey — follow the browser prompt...");

      const tk = new Turnkey({
        apiBaseUrl: config.apiBaseUrl,
        defaultOrganizationId: config.organizationId,
        rpId,
      });

      const displayName = walletName.trim() || "Arch Wallet";
      const passkey = await tk.passkeyClient().createUserPasskey({
        publicKey: {
          rp: { id: rpId, name: "Arch Wallet" },
          user: { name: `${externalUserId}-${Date.now()}`, displayName },
        },
      });

      setStatusMessage("Creating your wallet on the server...");

      const idempotencyKey =
        self.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const result = await client.createTurnkeyPasskeyWallet({
        idempotencyKey,
        body: {
          externalUserId,
          passkey: {
            challenge: passkey.encodedChallenge,
            attestation: passkey.attestation,
          },
        },
      });

      const account: WalletAccount = {
        id: result.resourceId,
        label: walletName.trim() || "Passkey Wallet",
        btcAddress: result.defaultAddress || "",
        publicKeyHex: result.defaultPublicKeyHex || "",
        archAddress: result.defaultPublicKeyHex
          ? deriveArchAccountAddress(result.defaultPublicKeyHex)
          : undefined,
        turnkeyResourceId: result.resourceId,
        organizationId: result.organizationId,
        isCustodial: false,
        createdAt: Date.now(),
      };

      await walletStore.completeOnboarding(account);
      finishOnboarding();
    } catch (e: any) {
      setError(e?.message || "Failed to create passkey wallet");
      setStep("welcome");
    }
  }, [finishOnboarding, buildClient, saveApiConfig]);

  const createCustodialWallet = useCallback(async () => {
    setStep("creating");
    setError(null);
    setStatusMessage("Creating custodial wallet...");
    try {
      await saveApiConfig();
      const client = buildClient();
      const externalUserId = getExternalUserId();
      const idempotencyKey =
        self.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const result = await client.createTurnkeyWallet({
        idempotencyKey,
        body: { externalUserId },
      });

      const account: WalletAccount = {
        id: result.resourceId,
        label: walletName.trim() || "Custodial Wallet",
        btcAddress: result.defaultAddress || "",
        publicKeyHex: result.defaultPublicKeyHex || "",
        archAddress: result.defaultPublicKeyHex
          ? deriveArchAccountAddress(result.defaultPublicKeyHex)
          : undefined,
        turnkeyResourceId: result.resourceId,
        organizationId: result.organizationId,
        isCustodial: true,
        createdAt: Date.now(),
      };

      await walletStore.completeOnboarding(account);
      finishOnboarding();
    } catch (e: any) {
      setError(e?.message || "Failed to create wallet");
      setStep("welcome");
    }
  }, [finishOnboarding, buildClient, saveApiConfig]);

  const connectExistingWallet = useCallback(async () => {
    setStep("creating");
    setError(null);
    setStatusMessage("Looking for existing wallets...");
    try {
      await saveApiConfig();
      const client = buildClient();
      const externalUserId = getExternalUserId();

      const res = await client.listTurnkeyWallets(externalUserId);
      const wallets = res?.wallets ?? [];

      if (wallets.length === 0) {
        setError("No existing wallets found. Create a new wallet first.");
        setStep("welcome");
        return;
      }

      const tw = wallets[0];
      const isCustodial = !(tw as any).subOrganizationId;

      const pubHex = (tw as any).defaultPublicKeyHex || "";
      const account: WalletAccount = {
        id: (tw as any).resourceId || (tw as any).id,
        label: isCustodial ? "Imported Custodial" : "Imported Passkey",
        btcAddress: (tw as any).defaultAddress || "",
        publicKeyHex: pubHex,
        archAddress: pubHex ? deriveArchAccountAddress(pubHex) : undefined,
        turnkeyResourceId: (tw as any).resourceId || (tw as any).id,
        organizationId: (tw as any).organizationId || "",
        isCustodial,
        createdAt: Date.now(),
      };

      await walletStore.completeOnboarding(account);
      finishOnboarding();
    } catch (e: any) {
      setError(e?.message || "Failed to connect wallet");
      setStep("welcome");
    }
  }, [finishOnboarding, buildClient, saveApiConfig]);

  if (step === "creating") {
    return (
      <div className="onboarding">
        <div className="spinner" style={{ width: 40, height: 40, borderWidth: 3 }} />
        <p style={{ color: "var(--text-secondary)" }}>{statusMessage}</p>
      </div>
    );
  }

  return (
    <div className="onboarding">
      <div className="onboarding-logo">
        <img src="/arch-logo.svg" alt="Arch" style={{ width: 64, height: 64 }} />
      </div>
      <h1 className="onboarding-title">
        {addMode ? "Add Wallet" : "Arch Wallet"}
      </h1>
      <p className="onboarding-sub">
        {addMode
          ? "Create or import an additional wallet."
          : "A self-custodial wallet for Bitcoin, ARCH, and APL tokens on the Arch Network."}
      </p>

      {error && <div className="error-banner">{error}</div>}

      <button
        className="btn-link"
        onClick={() => setShowServerSettings((v) => !v)}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 11,
          textDecoration: "underline",
          marginBottom: 8,
          padding: 0,
        }}
      >
        {showServerSettings ? "▾ Hide Server Settings" : "▸ Server Settings"}
      </button>

      {showServerSettings && (
        <div className="card" style={{ marginBottom: 12, textAlign: "left" }}>
          <div style={{ marginBottom: 8 }}>
            <label className="input-label" style={{ display: "block", marginBottom: 4 }}>
              API Base URL
            </label>
            <input
              className="input"
              type="text"
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              placeholder="http://44.222.123.237:3005"
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </div>
          <div>
            <label className="input-label" style={{ display: "block", marginBottom: 4 }}>
              API Key
            </label>
            <input
              className="input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your API key"
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </div>
        </div>
      )}

      <div style={{ marginBottom: 12, textAlign: "left" }}>
        <label className="input-label" style={{ display: "block", marginBottom: 4 }}>
          Wallet Name
        </label>
        <input
          className="input"
          type="text"
          value={walletName}
          onChange={(e) => setWalletName(e.target.value)}
          placeholder="e.g. My Daily Wallet"
          style={{ width: "100%", boxSizing: "border-box" }}
        />
      </div>

      <div className="onboarding-actions">
        <button className="btn btn-primary btn-full" onClick={createNonCustodialWallet}>
          🔐 Create Wallet
        </button>

        <div style={{
          display: "flex",
          gap: 8,
          marginTop: 4,
        }}>
          <button
            className="btn btn-secondary"
            onClick={createCustodialWallet}
            style={{ flex: 1, fontSize: 12, padding: "8px 4px" }}
          >
            🏦 Custodial Wallet
          </button>
          <button
            className="btn btn-secondary"
            onClick={connectExistingWallet}
            style={{ flex: 1, fontSize: 12, padding: "8px 4px" }}
          >
            📋 Import Existing
          </button>
        </div>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
        <strong>Create Wallet</strong> — secured by your device passkey (non-custodial).
        <br />
        <em>Custodial</em> — server-managed keys for simpler onboarding.
      </p>
    </div>
  );
}
