import { useState, useCallback } from "react";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import { walletStore } from "../../state/wallet-store";
import { getExternalUserId, invalidateClientCache } from "../../utils/sdk";
import type { WalletAccount } from "../../state/types";

interface OnboardingProps {
  onComplete: () => void;
}

type Step = "welcome" | "creating";

const DEFAULT_BASE_URL = "http://localhost:3005";

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [error, setError] = useState<string | null>(null);
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState("");

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

  const createPasskeyWallet = useCallback(async () => {
    setStep("creating");
    setError(null);
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
        label: "Arch Wallet",
        btcAddress: result.defaultAddress || "",
        publicKeyHex: result.defaultPublicKeyHex || "",
        turnkeyResourceId: result.resourceId,
        organizationId: result.organizationId,
        createdAt: Date.now(),
      };

      await walletStore.completeOnboarding(account);
      onComplete();
    } catch (e: any) {
      setError(e?.message || "Failed to create wallet");
      setStep("welcome");
    }
  }, [onComplete, buildClient, saveApiConfig]);

  const connectExistingWallet = useCallback(async () => {
    setStep("creating");
    setError(null);
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
      const account: WalletAccount = {
        id: (tw as any).resourceId || (tw as any).id,
        label: (tw as any).walletName || "Imported Wallet",
        btcAddress: (tw as any).defaultAddress || "",
        publicKeyHex: (tw as any).defaultPublicKeyHex || "",
        turnkeyResourceId: (tw as any).resourceId || (tw as any).id,
        organizationId: (tw as any).organizationId || "",
        createdAt: Date.now(),
      };

      await walletStore.completeOnboarding(account);
      onComplete();
    } catch (e: any) {
      setError(e?.message || "Failed to connect wallet");
      setStep("welcome");
    }
  }, [onComplete, buildClient, saveApiConfig]);

  if (step === "creating") {
    return (
      <div className="onboarding">
        <div className="spinner" style={{ width: 40, height: 40, borderWidth: 3 }} />
        <p style={{ color: "var(--text-secondary)" }}>Setting up your wallet...</p>
      </div>
    );
  }

  return (
    <div className="onboarding">
      <div className="onboarding-logo">
        <img src="/arch-logo.svg" alt="Arch" style={{ width: 64, height: 64 }} />
      </div>
      <h1 className="onboarding-title">Arch Wallet</h1>
      <p className="onboarding-sub">
        A self-custodial wallet for Bitcoin, ARCH, and APL tokens on the Arch Network.
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
              placeholder="http://localhost:3005"
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

      <div className="onboarding-actions">
        <button className="btn btn-primary btn-full" onClick={createPasskeyWallet}>
          🔑 Create with Passkey
        </button>
        <button className="btn btn-secondary btn-full" onClick={connectExistingWallet}>
          📋 Connect Existing Wallet
        </button>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
        Your keys are secured by Turnkey &mdash; only you can sign transactions.
      </p>
    </div>
  );
}
